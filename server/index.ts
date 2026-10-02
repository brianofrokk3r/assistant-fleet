import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deploymentFromConfiguration,
  validateTenantConfiguration,
  type ActivityRecord,
  type Deployment,
  type FleetState,
  type OperationResult,
  type RepositorySnapshot,
  type TenantConfiguration,
} from '../shared/types.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.FLEET_ROOT || path.join(moduleDir, '..'));
const dataDir = path.resolve(process.env.FLEET_DATA_DIR || path.join(projectRoot, 'data'));
const tenantsDir = path.join(projectRoot, 'tenants');
const skillsetsDir = path.join(projectRoot, 'rendered-skillsets');
const snapshotsDir = path.join(projectRoot, 'repository-snapshots');
const stateFile = path.join(dataDir, 'state.json');
const distDir = path.resolve(process.env.FLEET_UI_DIR || path.join(projectRoot, 'dist'));
const port = Number(process.env.FLEET_PORT || 8080);
const bindHost = process.env.FLEET_BIND_HOST || '127.0.0.1';
const serveStatic = process.env.FLEET_SERVE_STATIC !== 'false';
const dockerEnabled = process.env.FLEET_DOCKER_ENABLED !== 'false';
const maxOutputBytes = 512_000;

const emptyState = (): FleetState => ({ deployments: [], activities: [] });

async function ensureLayout(): Promise<void> {
  await Promise.all([dataDir, tenantsDir, skillsetsDir, snapshotsDir].map(directory => mkdir(directory, { recursive: true })));
}

async function readState(): Promise<FleetState> {
  await ensureLayout();
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as FleetState;
    return { deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [], activities: Array.isArray(parsed.activities) ? parsed.activities : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function writeState(state: FleetState): Promise<void> {
  await ensureLayout();
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

function yaml(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function parseExtraEnvironment(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid environment override: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (/(TOKEN|PASSWORD|SECRET|PRIVATE_KEY|API_KEY)/.test(key)) throw new Error(`Secret-like environment key ${key} must use a secret reference, not an inline value.`);
    result[key] = value;
  }
  return result;
}

function secretVariableName(reference: string): string {
  if (reference.startsWith('env://')) return reference.slice(6);
  if (reference.startsWith('secret://')) return `FLEET_SECRET_${reference.slice(9).replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  if (reference.startsWith('file://')) return `FLEET_FILE_${Buffer.from(reference).toString('hex').slice(0, 20).toUpperCase()}`;
  throw new Error(`Unsupported secret reference ${reference}. Use secret://, env://, or file://.`);
}

async function resolveSecret(reference: string): Promise<{ variable: string; value: string }> {
  const variable = secretVariableName(reference);
  let value: string | undefined;
  if (reference.startsWith('file://')) value = (await readFile(reference.slice(7), 'utf8')).trimEnd();
  else value = process.env[variable];
  if (!value) throw new Error(`Secret reference ${reference} is unresolved. Set ${variable} or provide the referenced file.`);
  return { variable, value };
}

function providerSecretEnvironment(config: TenantConfiguration): string {
  if (config.providerSecretEnvName) return config.providerSecretEnvName;
  if (config.provider === 'codex') return 'OPENAI_API_KEY';
  if (config.provider === 'copilot') return 'COPILOT_GITHUB_TOKEN';
  return 'OPENROUTER_API_KEY';
}

function composeEnvironment(config: TenantConfiguration): Record<string, string | boolean> {
  const environment: Record<string, string | boolean> = {
    HOME: '/data',
    AI_ASSISTANT_ADAPTER: config.type,
    AI_ASSISTANT_SECURITY_MODE: config.securityMode,
    AI_ASSISTANT_CONFIG_DIR: config.configDir,
    AI_ASSISTANT_STATE_DIR: config.stateDir,
    AI_ASSISTANT_WORKSPACE_ROOT: config.workspaceRoot,
    AI_ASSISTANT_SYSTEM_PROMPT_FILE: config.systemPromptFile,
    AI_ASSISTANT_BROWSER_URL: config.browserUrl,
    PROVIDER: config.provider,
    REGISTER_COMMANDS_ON_START: config.type === 'slack' ? false : config.registerCommands,
    AI_PROGRESS_INTERVAL_MS: config.progressIntervalMs,
    AI_INPUT_ATTACHMENT_MAX_BYTES: config.inputMaxBytes,
    AI_OUTPUT_ATTACHMENT_MAX_BYTES: config.outputMaxBytes,
    AI_MEDIA_TIMEOUT_MS: config.mediaTimeoutMs,
    AI_CANCELLATION_GRACE_MS: config.cancellationGraceMs,
    SCHEDULES_ENABLED: config.schedulesEnabled,
    AI_ASSISTANT_ENABLE_SITES: config.enableSites,
    AI_ASSISTANT_ENABLE_GITHUB_CONTRIBUTIONS: config.enableGithubContributions,
  };
  if (config.mcpConfigPath) environment.MCP_CONFIG_PATH = config.mcpConfigPath;
  if (config.provider === 'copilot') {
    if (config.model) environment.COPILOT_MODEL = config.model;
    environment.COPILOT_TIMEOUT_MS = config.timeoutMs;
  } else if (config.provider === 'codex') {
    if (config.model) environment.CODEX_MODEL = config.model;
    environment.CODEX_TIMEOUT_MS = config.timeoutMs;
    environment.CODEX_REASONING_EFFORT = config.reasoningEffort;
    environment.CODEX_WEB_SEARCH_MODE = config.webSearchMode;
  } else {
    if (config.model) environment.OPENCODE_MODEL = config.model;
    environment.OPENCODE_BIN = config.openCodeBin;
    environment.OPENCODE_TIMEOUT_MS = config.timeoutMs;
  }
  if (config.type === 'slack') {
    environment.SLACK_TEAM_ID = config.teamId;
    environment.SLACK_ALLOWED_CHANNELS = config.allowedChannels;
    environment.SLACK_ALLOWED_USERS = config.allowedUsers;
    environment.SLACK_INSTALLATION_ID = config.installationId;
    if (config.excludedSlackUsers) environment.SLACK_EXCLUDED_CONTEXT_USERS = config.excludedSlackUsers;
  } else {
    environment.DISCORD_APP_ID = config.discordAppId;
    environment.DISCORD_GUILD_ID = config.discordGuildId;
    environment.DISCORD_ALLOWED_USERS = config.discordAllowedUsers;
    environment.DISCORD_ADMIN_USERS = config.discordAdminUsers;
    environment.DISCORD_FREE_CHANNELS = config.freeChannels;
    environment.DISCORD_ATTACHMENT_MODE = config.attachmentMode;
    environment.DISCORD_SUPPRESS_EMBEDS = config.suppressEmbeds;
    environment.CHAT_PARTICIPATION_MODE = config.participationMode;
    environment.CHAT_PARTICIPATION_EVALUATOR = config.participationEvaluator;
    environment.CHAT_PARTICIPATION_REASONING = config.participationReasoning;
    environment.CHAT_PARTICIPATION_TIMEOUT_MS = config.participationTimeoutMs;
    environment.DISCORD_SEARCH_CANDIDATE_LIMIT = config.searchCandidateLimit;
    environment.DISCORD_SEARCH_CONTEXT_LIMIT = config.searchContextLimit;
    environment.DISCORD_MEMORY_RECALL_LIMIT = config.memoryRecallLimit;
  }
  return { ...environment, ...parseExtraEnvironment(config.extraEnv) };
}

function placeholder(variable: string, message: string): string {
  return `\${${variable}:?${message}}`;
}

async function renderTenant(deployment: Deployment): Promise<string> {
  const config = deployment.configuration;
  if (!config) throw new Error('Deployment has no typed tenant configuration.');
  const validation = validateTenantConfiguration(config);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  const tenantDir = path.join(tenantsDir, deployment.id);
  const skillDir = path.join(skillsetsDir, deployment.id);
  await Promise.all([tenantDir, skillDir, path.join(tenantDir, 'revisions')].map(directory => mkdir(directory, { recursive: true })));
  const promptFile = path.join(tenantDir, 'prompt.md');
  try { await stat(promptFile); } catch { await writeFile(promptFile, `# ${deployment.name} assistant\n\nAnswer with evidence from the tenant's authorized workspace.\n`, { mode: 0o644 }); }

  const environment = composeEnvironment(config);
  if (config.type === 'slack') {
    environment.SLACK_APP_TOKEN = placeholder(secretVariableName(config.slackAppTokenRef), 'Slack app token is required');
    environment.SLACK_BOT_TOKEN = placeholder(secretVariableName(config.slackBotTokenRef), 'Slack bot token is required');
    if (config.historyTokenRef) environment.SLACK_HISTORY_TOKEN = placeholder(secretVariableName(config.historyTokenRef), 'Slack history token is required');
  } else {
    environment.DISCORD_TOKEN = placeholder(secretVariableName(config.discordTokenRef), 'Discord bot token is required');
  }
  if (config.providerAuthMode === 'secret-reference') {
    environment[providerSecretEnvironment(config)] = placeholder(secretVariableName(config.providerSecretRef), 'Provider credential is required');
  }
  for (const secret of config.secretEnvironment ?? []) {
    environment[secret.name] = placeholder(secretVariableName(secret.reference), `${secret.name} is required`);
  }

  const environmentYaml = Object.entries(environment).map(([key, value]) => `      ${key}: ${yaml(value)}`).join('\n');
  const knowledgeVolumes = deployment.repositoryList.map(snapshot => {
    const source = path.relative(tenantDir, path.join(snapshotsDir, snapshot.name, 'releases', snapshot.revision));
    return `      - ${yaml(`${source}:/data/workspaces/knowledge/${snapshot.name}:ro`)}`;
  });
  const skillTarget = config.provider === 'codex' ? '/data/.codex/skills' : '/data/.agents/skills';
  const skillSource = path.relative(tenantDir, skillDir);
  const workspaceVolume = config.managedWorkspace ? `      - ${yaml('./workspace:/data/workspaces')}` : '';
  const relay = config.n8nRelay?.enabled ? `\n  n8n-relay:\n    image: ${yaml(config.image)}\n    entrypoint: ["node", "/app/dist/src/n8nIntakeRelay.js"]\n    restart: unless-stopped\n    init: true\n    environment:\n      N8N_INTAKE_ROOT: /content/content/marketing\n      N8N_INTAKE_URL: ${yaml(config.n8nRelay.intakeUrl)}\n      N8N_INTAKE_TOKEN: ${yaml(placeholder(secretVariableName(config.n8nRelay.intakeTokenRef), 'n8n intake token is required'))}\n      N8N_INTAKE_HEADER_NAME: ${yaml(config.n8nRelay.headerName)}\n      N8N_INTAKE_POLL_MS: ${yaml(config.n8nRelay.pollMs)}\n    volumes:\n      - ${yaml('./workspace:/content')}\n    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    pids_limit: 32\n    networks:\n      - default\n` : '';
  const volumeDefinition = config.dataVolumeName
    ? `  assistant-data:\n    external: true\n    name: ${yaml(config.dataVolumeName)}`
    : '  assistant-data:';
  const compose = `# Generated by Assistant Fleet. Edit deployment.json through the control plane.\nname: ${yaml(deployment.project)}\nservices:\n  assistant:\n    image: ${yaml(config.image)}\n    restart: unless-stopped\n    stop_grace_period: 11m\n    init: true\n    environment:\n${environmentYaml}\n    depends_on:\n      browser:\n        condition: service_healthy\n    networks:\n      - default\n      - browser-control\n    extra_hosts:\n      - host.docker.internal:host-gateway\n    volumes:\n      - assistant-data:/data\n      - ${yaml('./prompt.md:/config/prompt.md:ro')}\n      - ${yaml(`${skillSource}:${skillTarget}:ro`)}\n${workspaceVolume ? `${workspaceVolume}\n` : ''}${knowledgeVolumes.join('\n')}${knowledgeVolumes.length ? '\n' : ''}    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    pids_limit: 256\n\n  browser:\n    image: ${yaml(config.image)}\n    entrypoint: ["node", "/app/dist/src/browserWorker.js"]\n    restart: unless-stopped\n    init: true\n    mem_limit: 1g\n    memswap_limit: 1g\n    pids_limit: 256\n    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3123/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n      interval: 10s\n      timeout: 3s\n      retries: 3\n    networks:\n      - browser-control\n      - browser-egress\n${relay}\nvolumes:\n${volumeDefinition}\n\nnetworks:\n  browser-control:\n    internal: true\n  browser-egress:\n`;
  await Promise.all([
    writeFile(path.join(tenantDir, 'compose.generated.yaml'), compose, { mode: 0o600 }),
    writeFile(path.join(tenantDir, 'deployment.json'), `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return compose;
}

async function composeSecrets(deployment: Deployment): Promise<NodeJS.ProcessEnv> {
  const config = deployment.configuration;
  if (!config) throw new Error('Deployment has no configuration.');
  const references = [
    config.type === 'slack' ? config.slackAppTokenRef : config.discordTokenRef,
    ...(config.type === 'slack' ? [config.slackBotTokenRef, config.historyTokenRef].filter(Boolean) : []),
    ...(config.providerAuthMode === 'secret-reference' ? [config.providerSecretRef] : []),
    ...(config.secretEnvironment ?? []).map(secret => secret.reference),
    ...(config.n8nRelay?.enabled ? [config.n8nRelay.intakeTokenRef] : []),
  ];
  const resolved = await Promise.all(references.map(resolveSecret));
  return Object.fromEntries(resolved.map(item => [item.variable, item.value]));
}

interface CommandResult { stdout: string; stderr: string; code: number }

async function runCommand(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-maxOutputBytes);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Command timed out after ${options.timeoutMs ?? 600_000}ms.`)); }, options.timeoutMs ?? 600_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

async function runCompose(deployment: Deployment, args: string[], timeoutMs?: number): Promise<CommandResult> {
  if (!dockerEnabled) throw new Error('Docker operations are disabled by FLEET_DOCKER_ENABLED=false.');
  const tenantDir = path.join(tenantsDir, deployment.id);
  await renderTenant(deployment);
  const env = await composeSecrets(deployment);
  const result = await runCommand('docker', ['compose', '--project-name', deployment.project, '--file', 'compose.generated.yaml', ...args], { cwd: tenantDir, env, timeoutMs });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `Docker Compose exited with ${result.code}`).trim());
  return result;
}

function activity(kind: ActivityRecord['kind'], tone: ActivityRecord['tone'], title: string, detail: string, deploymentId?: string): ActivityRecord {
  return { id: crypto.randomUUID(), kind, tone, title, detail, deploymentId, createdAt: new Date().toISOString() };
}

async function recordRevision(deployment: Deployment): Promise<void> {
  const revisionsDir = path.join(tenantsDir, deployment.id, 'revisions');
  await mkdir(revisionsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(path.join(revisionsDir, `${stamp}.json`), `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
}

async function operate(id: string, action: string): Promise<OperationResult> {
  const state = await readState();
  const index = state.deployments.findIndex(item => item.id === id);
  if (index < 0) return { ok: false, action, error: 'Deployment not found.' };
  let deployment = state.deployments[index];
  try {
    let result: CommandResult;
    if (action === 'deploy' || action === 'resume') {
      result = await runCompose(deployment, ['up', '-d', '--remove-orphans'], 900_000);
      deployment = { ...deployment, status: 'healthy', image: deployment.desiredImage, updated: 'Just now', issue: undefined };
    } else if (action === 'suspend') {
      result = await runCompose(deployment, ['stop']);
      deployment = { ...deployment, status: 'suspended', updated: 'Just now', issue: undefined };
    } else if (action === 'verify') {
      const configResult = await runCompose(deployment, ['config', '--quiet']);
      const psResult = await runCompose(deployment, ['ps', '--format', 'json']);
      result = { stdout: `${configResult.stdout}${psResult.stdout}`, stderr: `${configResult.stderr}${psResult.stderr}`, code: 0 };
    } else if (action === 'rollback') {
      const revisionsDir = path.join(tenantsDir, id, 'revisions');
      const revisions = (await readdir(revisionsDir)).filter(name => name.endsWith('.json')).sort();
      const latest = revisions.at(-1);
      if (!latest) throw new Error('No previous revision is available for rollback.');
      deployment = JSON.parse(await readFile(path.join(revisionsDir, latest), 'utf8')) as Deployment;
      await unlink(path.join(revisionsDir, latest));
      result = await runCompose(deployment, ['up', '-d', '--remove-orphans'], 900_000);
      deployment = { ...deployment, status: 'healthy', updated: 'Just now', issue: undefined };
    } else {
      return { ok: false, action, error: `Unsupported action ${action}.` };
    }
    state.deployments[index] = deployment;
    const activityDetail = action === 'verify'
      ? 'Runtime and Compose checks passed.'
      : (result.stdout || 'Docker Compose completed successfully.').trim().slice(0, 500);
    state.activities.unshift(activity(action as ActivityRecord['kind'], action === 'suspend' ? 'amber' : 'green', `${deployment.name} ${action} completed`, activityDetail, id));
    state.activities = state.activities.slice(0, 500);
    await writeState(state);
    return { ok: true, action, deployment, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deployment = { ...deployment, status: 'attention', issue: message, updated: 'Just now' };
    state.deployments[index] = deployment;
    state.activities.unshift(activity('error', 'amber', `${deployment.name} ${action} failed`, message, id));
    await writeState(state);
    return { ok: false, action, deployment, error: message };
  }
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > 2_000_000) throw new Error('Request body exceeds 2 MB.');
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  response.end(payload);
}

function requireApiToken(request: IncomingMessage): boolean {
  const expected = process.env.FLEET_API_TOKEN;
  return !expected || request.headers.authorization === `Bearer ${expected}`;
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!requireApiToken(request)) return sendJson(response, 401, { error: 'Unauthorized.' });
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, dockerEnabled, root: projectRoot });
  if (request.method === 'GET' && (url.pathname === '/api/state' || url.pathname === '/api/deployments')) return sendJson(response, 200, await readState());

  if (request.method === 'POST' && url.pathname === '/api/deployments') {
    const body = await parseBody(request);
    const validation = validateTenantConfiguration(body);
    if (!validation.valid) return sendJson(response, 422, { error: 'Invalid tenant configuration.', errors: validation.errors });
    const config = body as TenantConfiguration;
    const state = await readState();
    if (state.deployments.some(item => item.id === config.slug)) return sendJson(response, 409, { error: 'A deployment with this slug already exists.' });
    const deployment = deploymentFromConfiguration(config);
    await renderTenant(deployment);
    state.deployments.push(deployment);
    state.activities.unshift(activity('created', 'blue', `${deployment.name} created`, `${deployment.adapter} · ${deployment.provider}`, deployment.id));
    await writeState(state);
    return sendJson(response, 201, { deployment });
  }

  const match = url.pathname.match(/^\/api\/deployments\/([a-z0-9-]+)(?:\/(.*))?$/);
  if (!match) return sendJson(response, 404, { error: 'API route not found.' });
  const [, id, suffix = ''] = match;
  const state = await readState();
  const index = state.deployments.findIndex(item => item.id === id);
  if (index < 0) return sendJson(response, 404, { error: 'Deployment not found.' });

  if (request.method === 'PUT' && suffix === '') {
    const body = await parseBody(request);
    const validation = validateTenantConfiguration(body);
    if (!validation.valid) return sendJson(response, 422, { error: 'Invalid tenant configuration.', errors: validation.errors });
    const config = body as TenantConfiguration;
    if (config.slug !== id) return sendJson(response, 422, { error: 'Tenant slug cannot be changed after creation.' });
    const previous = state.deployments[index];
    await recordRevision(previous);
    const updated = {
      ...deploymentFromConfiguration(config),
      status: previous.status,
      repositoryList: previous.repositoryList,
      sharedSkills: previous.sharedSkills,
      tenantSkills: previous.tenantSkills,
      storage: previous.storage,
      updated: 'Just now',
    } satisfies Deployment;
    await renderTenant(updated);
    state.deployments[index] = updated;
    state.activities.unshift(activity('updated', 'blue', `${updated.name} configuration updated`, `${updated.adapter} · ${updated.provider}`, id));
    await writeState(state);
    return sendJson(response, 200, { deployment: updated });
  }

  if (request.method === 'GET' && suffix === 'compose') {
    const compose = await renderTenant(state.deployments[index]);
    response.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'cache-control': 'no-store' });
    response.end(compose);
    return;
  }
  if (request.method === 'GET' && suffix === 'logs') {
    try {
      const result = await runCompose(state.deployments[index], ['logs', '--tail', '250', '--no-color']);
      return sendJson(response, 200, { logs: `${result.stdout}${result.stderr}` });
    } catch (error) { return sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && suffix.startsWith('actions/')) {
    const result = await operate(id, suffix.slice(8));
    return sendJson(response, result.ok ? 200 : 503, result);
  }
  if (request.method === 'POST' && suffix === 'repositories') {
    const body = await parseBody(request) as Partial<RepositorySnapshot>;
    if (!body.name || !/^[a-zA-Z0-9._-]+$/.test(body.name) || !body.revision || !/^[a-zA-Z0-9._-]+$/.test(body.revision)) return sendJson(response, 422, { error: 'Repository name and revision are required and must be path-safe.' });
    const snapshotPath = path.join(snapshotsDir, body.name, 'releases', body.revision);
    try { await stat(snapshotPath); } catch { return sendJson(response, 422, { error: `Snapshot directory does not exist: ${snapshotPath}` }); }
    await recordRevision(state.deployments[index]);
    const repository: RepositorySnapshot = { name: body.name, revision: body.revision };
    state.deployments[index] = { ...state.deployments[index], repositoryList: [...state.deployments[index].repositoryList.filter(item => item.name !== repository.name), repository], updated: 'Just now' };
    await renderTenant(state.deployments[index]);
    state.activities.unshift(activity('repository', 'blue', `${repository.name} mounted`, `${id} · ${repository.revision}`, id));
    await writeState(state);
    return sendJson(response, 200, { deployment: state.deployments[index] });
  }
  return sendJson(response, 404, { error: 'API route not found.' });
}

const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveAsset(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = path.resolve(distDir, requested);
  const target = resolved.startsWith(`${distDir}${path.sep}`) ? resolved : path.join(distDir, 'index.html');
  try {
    const info = await stat(target);
    const file = info.isFile() ? target : path.join(distDir, 'index.html');
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
    createReadStream(file).pipe(response);
  } catch {
    const fallback = path.join(distDir, 'index.html');
    try { await stat(fallback); response.writeHead(200, { 'content-type': mimeTypes['.html'], 'cache-control': 'no-cache' }); createReadStream(fallback).pipe(response); }
    catch { sendJson(response, 503, { error: 'Frontend build is unavailable. Run npm run build.' }); }
  }
}

await ensureLayout();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (serveStatic) await serveAsset(response, url.pathname);
    else sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, bindHost, () => {
  process.stdout.write(`Assistant Fleet API listening on http://${bindHost}:${port} (docker ${dockerEnabled ? 'enabled' : 'disabled'})\n`);
});

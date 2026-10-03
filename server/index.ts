import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, chown, lstat, mkdir, readFile, rename, stat, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deploymentFromConfiguration,
  validateContributionRepository,
  validateTenantConfiguration,
  type ActivityRecord,
  type Contribution,
  type ContributionRepository,
  type ContributionRepositoryInput,
  type Deployment,
  type FleetState,
  type OperationResult,
  type RepositorySnapshot,
  type TenantConfiguration,
} from '../shared/types.ts';
import { ContributionError, ContributionRuntime } from './contributions.ts';

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
const allowLocalContributionRemotes = process.env.FLEET_E2E_ALLOW_LOCAL_REMOTES === 'true';
const maxOutputBytes = 512_000;

const emptyState = (): FleetState => ({ deployments: [], activities: [], contributionRepositories: [], contributions: [] });

async function ensureLayout(): Promise<void> {
  await Promise.all([dataDir, tenantsDir, skillsetsDir, snapshotsDir].map(directory => mkdir(directory, { recursive: true })));
}

async function readState(): Promise<FleetState> {
  await ensureLayout();
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as FleetState;
    return {
      deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [],
      activities: Array.isArray(parsed.activities) ? parsed.activities : [],
      contributionRepositories: Array.isArray(parsed.contributionRepositories) ? parsed.contributionRepositories : [],
      contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    };
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

const contributionRuntime = new ContributionRuntime({ tenantsDir, resolveSecret });
const contributionBrokers = new Map<string, ReturnType<typeof createServer>>();
const contributionQueueTimers = new Map<string, ReturnType<typeof setInterval>>();
const contributionQueueBusy = new Set<string>();

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

function assignedContributionRepositories(deployment: Deployment, repositories: ContributionRepository[]): ContributionRepository[] {
  return repositories.filter(repository => repository.enabled && repository.assignedTenants.includes(deployment.id));
}

async function renderContributionSkill(skillDir: string, repositories: ContributionRepository[]): Promise<void> {
  if (!repositories.length) return;
  const directory = path.join(skillDir, 'fleet-contribute');
  await mkdir(directory, { recursive: true });
  const aliases = repositories.map(repository => `- \`${repository.alias}\` (base \`${repository.defaultBranch}\`, branches \`${repository.branchPrefix}*\`)`).join('\n');
  const skill = `---
name: fleet-contribute
description: Inspect or change repositories assigned by Assistant Fleet using isolated checkouts and brokered contribution-branch publishing.
---

# Fleet contribution workflow

Use this skill whenever a user asks you to inspect or change an assigned contribution repository. Do not claim that a repository is unavailable before running \`fleet-contribute list\`.

Assigned repositories:
${aliases}

## Workflow

1. Run \`fleet-contribute list\`.
2. Run \`fleet-contribute prepare <alias>\`. The response contains the isolated \`workspacePath\`, contribution ID, generated branch, and pinned \`baseSha\`.
3. Inspect, edit, and test only inside that exact workspace path.
4. Review the diff and run checks appropriate to the repository and change.
5. For a requested repository change, publish the validated result with \`fleet-contribute publish <id> --base <baseSha> --message "<message>"\`, unless the user explicitly requested local-only work, no push, or confirmation before publishing.
6. Report the pushed branch and pull-request handoff URL. This workflow creates neither the pull request nor a merge.

## Publishing boundary

A request to implement or change the assigned repository authorizes pushing only the generated contribution branch through \`fleet-contribute publish\`. It does not authorize pushing another branch, creating or merging a pull request, or making unrelated external changes.

\`fleet-contribute publish\` delegates the authenticated push to the Fleet controller. A Slack session, a sandbox without direct network access, or an agent approval mode such as \`never\` does not disable this brokered command. Attempt the command and rely on its actual result. Do not claim that external publishing is disabled unless the command itself returns that error.

If publishing fails, do not claim that a remote branch or pull request exists. Report the exact error and preserve the contribution for a later retry; do not repeatedly retry without new evidence that the failure condition changed.

Never read or request repository credentials. Never change the generated branch, base SHA, Git remote, hooks, protected paths, or files outside the isolated checkout.
`;
  await writeFile(path.join(directory, 'SKILL.md'), skill, { mode: 0o644 });
}

async function renderContributionPrompt(promptFile: string, repositories: ContributionRepository[]): Promise<void> {
  const start = '<!-- assistant-fleet:contributions:start -->';
  const end = '<!-- assistant-fleet:contributions:end -->';
  const current = await readFile(promptFile, 'utf8');
  const withoutManagedSection = current.replace(new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, 'g'), '').trimEnd();
  if (!repositories.length) {
    if (withoutManagedSection !== current.trimEnd()) await writeFile(promptFile, `${withoutManagedSection}\n`, { mode: 0o644 });
    return;
  }
  const aliases = repositories.map(repository => `\`${repository.alias}\``).join(', ');
  const managedSection = `${start}\n## Contribution repositories\n\nAssigned aliases: ${aliases}.\n\nWhen a user asks you to inspect or change an assigned repository, use the \`fleet-contribute\` skill. Run \`fleet-contribute list\` and then \`fleet-contribute prepare <alias>\` before inspecting files. The alias directory under \`/data/workspaces/contributions\` is only a parent directory and is not itself a Git checkout. An empty parent directory does not mean repository access is unavailable. Use the exact \`workspacePath\`, contribution ID, generated branch, and base SHA returned by \`prepare\`.\n\nFor a requested repository change, completion includes publishing the validated generated branch with \`fleet-contribute publish\` and returning its pull-request handoff URL, unless the user explicitly requests local-only work, no push, or confirmation first. Publishing is brokered by Fleet; do not infer that it is disabled merely because the Slack/Codex sandbox lacks direct external network access. The workflow does not create or merge a pull request.\n${end}`;
  await writeFile(promptFile, `${withoutManagedSection}\n\n${managedSection}\n`, { mode: 0o644 });
}

async function renderTenant(deployment: Deployment, contributionRepositories: ContributionRepository[] = []): Promise<string> {
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
  const assignedRepositories = assignedContributionRepositories(deployment, contributionRepositories);
  await renderContributionPrompt(promptFile, assignedRepositories);
  if (assignedRepositories.length) {
    await ensureContributionBroker(deployment.id);
    environment.FLEET_CONTRIBUTION_SOCKET = '/data/workspaces/.fleet-contribution/broker.sock';
    environment.FLEET_CONTRIBUTION_QUEUE = '/data/workspaces/.fleet-contribution';
    environment.FLEET_CONTRIBUTION_REPOSITORIES = JSON.stringify(assignedRepositories.map(repository => ({
      id: repository.id,
      alias: repository.alias,
      provider: repository.provider,
      remote: repository.remote,
      defaultBranch: repository.defaultBranch,
      credentialRef: repository.credentialRef,
      branchPrefix: repository.branchPrefix,
    })));
    const contributionWorkspace = path.join(tenantDir, 'workspace', 'contributions');
    await mkdir(contributionWorkspace, { recursive: true, mode: 0o775 });
    try { if (process.getuid?.() === 0) await chown(contributionWorkspace, 10001, 10001); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await chmod(contributionWorkspace, 0o777);
    }
    await renderContributionSkill(skillDir, assignedRepositories);
  }
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
  const initializeData = `mkdir -p /data/.codex /data/.agents ${skillTarget} /data/workspaces && cp -R /managed-skills/. ${skillTarget}/ && chown -R 10001:10001 /data/.codex /data/.agents /data/workspaces && chown 10001:10001 /data`;
  const managedWorkspaceVolume = config.managedWorkspace ? `      - ${yaml('./workspace:/data/workspaces')}` : '';
  const contributionVolumes = assignedRepositories.length ? [
    `      - ${yaml('./workspace/contributions:/data/workspaces/contributions')}`,
    `      - ${yaml('./workspace/.fleet-contribution:/data/workspaces/.fleet-contribution')}`,
    `      - ${yaml('../../runtime/fleet-contribute.mjs:/usr/local/bin/fleet-contribute:ro')}`,
  ].join('\n') : '';
  const workspaceVolume = [managedWorkspaceVolume, contributionVolumes].filter(Boolean).join('\n');
  const relay = config.n8nRelay?.enabled ? `\n  n8n-relay:\n    image: ${yaml(config.image)}\n    entrypoint: ["node", "/app/dist/src/n8nIntakeRelay.js"]\n    restart: unless-stopped\n    init: true\n    environment:\n      N8N_INTAKE_ROOT: /content/content/marketing\n      N8N_INTAKE_URL: ${yaml(config.n8nRelay.intakeUrl)}\n      N8N_INTAKE_TOKEN: ${yaml(placeholder(secretVariableName(config.n8nRelay.intakeTokenRef), 'n8n intake token is required'))}\n      N8N_INTAKE_HEADER_NAME: ${yaml(config.n8nRelay.headerName)}\n      N8N_INTAKE_POLL_MS: ${yaml(config.n8nRelay.pollMs)}\n    volumes:\n      - ${yaml('./workspace:/content')}\n    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    pids_limit: 32\n    networks:\n      - default\n` : '';
  const volumeDefinition = config.dataVolumeName
    ? `  assistant-data:\n    external: true\n    name: ${yaml(config.dataVolumeName)}`
    : '  assistant-data:';
  const compose = `# Generated by Assistant Fleet. Edit deployment.json through the control plane.\nname: ${yaml(deployment.project)}\nservices:\n  data-init:\n    image: ${yaml(config.image)}\n    user: "0:0"\n    entrypoint: ["sh", "-c", ${yaml(initializeData)}]\n    restart: "no"\n    volumes:\n      - assistant-data:/data\n      - ${yaml(`${skillSource}:/managed-skills:ro`)}\n    read_only: true\n    cap_drop: [ALL]\n    cap_add: [CHOWN, DAC_OVERRIDE]\n    security_opt:\n      - no-new-privileges:true\n\n  assistant:\n    image: ${yaml(config.image)}\n    restart: unless-stopped\n    stop_grace_period: 11m\n    init: true\n    environment:\n${environmentYaml}\n    depends_on:\n      data-init:\n        condition: service_completed_successfully\n      browser:\n        condition: service_healthy\n    networks:\n      - default\n      - browser-control\n    extra_hosts:\n      - host.docker.internal:host-gateway\n    volumes:\n      - assistant-data:/data\n      - ${yaml('./prompt.md:/config/prompt.md:ro')}\n${workspaceVolume ? `${workspaceVolume}\n` : ''}${knowledgeVolumes.join('\n')}${knowledgeVolumes.length ? '\n' : ''}    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    pids_limit: 256\n\n  browser:\n    image: ${yaml(config.image)}\n    entrypoint: ["node", "/app/dist/src/browserWorker.js"]\n    restart: unless-stopped\n    init: true\n    mem_limit: 1g\n    memswap_limit: 1g\n    pids_limit: 256\n    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=../../runtime/seccomp.json\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3123/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n      interval: 10s\n      timeout: 3s\n      retries: 3\n    networks:\n      - browser-control\n      - browser-egress\n${relay}\nvolumes:\n${volumeDefinition}\n\nnetworks:\n  browser-control:\n    internal: true\n  browser-egress:\n`;
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
  const state = await readState();
  await renderTenant(deployment, state.contributionRepositories);
  const env = await composeSecrets(deployment);
  const result = await runCommand('docker', ['compose', '--project-name', deployment.project, '--file', 'compose.generated.yaml', ...args], { cwd: tenantDir, env, timeoutMs });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `Docker Compose exited with ${result.code}`).trim());
  return result;
}

function activity(kind: ActivityRecord['kind'], tone: ActivityRecord['tone'], title: string, detail: string, deploymentId?: string): ActivityRecord {
  return { id: crypto.randomUUID(), kind, tone, title, detail, deploymentId, createdAt: new Date().toISOString() };
}

function assignedRepository(state: FleetState, tenantId: string, selector: string): ContributionRepository {
  const repository = state.contributionRepositories.find(item => item.id === selector || item.alias === selector);
  if (!repository || !repository.enabled || !repository.assignedTenants.includes(tenantId)) {
    throw new ContributionError('Contribution repository is not enabled and assigned to this tenant.', 404);
  }
  return repository;
}

async function prepareContribution(tenantId: string, selector: string, requestId: string): Promise<{ contribution: Contribution; created: boolean }> {
  let state = await readState();
  if (!state.deployments.some(deployment => deployment.id === tenantId)) throw new ContributionError('Deployment not found.', 404);
  let repository = assignedRepository(state, tenantId, selector);
  return await contributionRuntime.locked(repository.id, async () => {
    state = await readState();
    repository = assignedRepository(state, tenantId, selector);
    const existing = state.contributions.find(item => item.tenantId === tenantId && item.repositoryId === repository.id && item.requestId === requestId);
    if (existing) return { contribution: existing, created: false };
    const contribution = await contributionRuntime.prepare(tenantId, repository, requestId);
    state.contributions.push(contribution);
    state.activities.unshift(activity('contribution', 'blue', `${repository.alias} contribution prepared`, contribution.branch, tenantId));
    state.activities = state.activities.slice(0, 500);
    await writeState(state);
    return { contribution, created: true };
  });
}

async function publishContribution(tenantId: string, contributionId: string, input: { expectedBaseSha: string; message: string; branch?: string }): Promise<Contribution> {
  let state = await readState();
  const initial = state.contributions.find(item => item.id === contributionId && item.tenantId === tenantId);
  if (!initial) throw new ContributionError('Contribution not found.', 404);
  return await contributionRuntime.locked(initial.repositoryId, async () => {
    state = await readState();
    const index = state.contributions.findIndex(item => item.id === contributionId && item.tenantId === tenantId);
    if (index < 0) throw new ContributionError('Contribution not found.', 404);
    const current = state.contributions[index];
    const repository = assignedRepository(state, tenantId, current.repositoryId);
    const published = await contributionRuntime.publish(current, repository, input);
    state.contributions[index] = published;
    state.activities.unshift(activity('contribution', 'green', `${repository.alias} contribution published`, published.branch, tenantId));
    state.activities = state.activities.slice(0, 500);
    await writeState(state);
    return published;
  });
}

async function abortContribution(tenantId: string, contributionId: string): Promise<Contribution> {
  const state = await readState();
  const index = state.contributions.findIndex(item => item.id === contributionId && item.tenantId === tenantId);
  if (index < 0) throw new ContributionError('Contribution not found.', 404);
  const aborted = await contributionRuntime.abort(state.contributions[index]);
  state.contributions[index] = aborted;
  state.activities.unshift(activity('contribution', 'amber', `${aborted.repositoryAlias} contribution aborted`, aborted.branch, tenantId));
  await writeState(state);
  return aborted;
}

function contributionErrorStatus(error: unknown): number {
  return error instanceof ContributionError ? error.statusCode : 500;
}

interface ContributionBrokerResult { statusCode: number; body: unknown }

async function executeContributionBrokerRequest(tenantId: string, method: string, pathname: string, rawBody: unknown = {}): Promise<ContributionBrokerResult> {
  const body = rawBody && typeof rawBody === 'object' ? rawBody as Record<string, unknown> : {};
  if (method === 'GET' && pathname === '/repositories') {
    const state = await readState();
    const repositories = state.contributionRepositories
      .filter(repository => repository.enabled && repository.assignedTenants.includes(tenantId))
      .map(({ credentialRef: _credentialRef, ...repository }) => repository);
    return { statusCode: 200, body: { repositories } };
  }
  if (method === 'POST' && pathname === '/prepare') {
    const result = await prepareContribution(tenantId, typeof body.repository === 'string' ? body.repository : '', typeof body.requestId === 'string' ? body.requestId : '');
    return { statusCode: result.created ? 201 : 200, body: { contribution: result.contribution } };
  }
  if (method === 'GET' && pathname === '/contributions') {
    const state = await readState();
    return { statusCode: 200, body: { contributions: state.contributions.filter(item => item.tenantId === tenantId) } };
  }
  const match = pathname.match(/^\/contributions\/([a-f0-9-]+)(?:\/(publish|abort))?$/);
  if (match && method === 'GET' && !match[2]) {
    const state = await readState();
    const contribution = state.contributions.find(item => item.id === match[1] && item.tenantId === tenantId);
    if (!contribution) throw new ContributionError('Contribution not found.', 404);
    return { statusCode: 200, body: { contribution } };
  }
  if (match && method === 'POST' && match[2] === 'publish') {
    const contribution = await publishContribution(tenantId, match[1], {
      expectedBaseSha: typeof body.expectedBaseSha === 'string' ? body.expectedBaseSha : '',
      message: typeof body.message === 'string' ? body.message : '',
      branch: typeof body.branch === 'string' ? body.branch : undefined,
    });
    return { statusCode: 200, body: { contribution } };
  }
  if (match && method === 'POST' && match[2] === 'abort') {
    return { statusCode: 200, body: { contribution: await abortContribution(tenantId, match[1]) } };
  }
  return { statusCode: 404, body: { error: 'Contribution broker route not found.' } };
}

async function handleContributionBroker(tenantId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    const body = request.method === 'POST' ? await parseBody(request) : {};
    const result = await executeContributionBrokerRequest(tenantId, request.method ?? 'GET', url.pathname, body);
    return sendJson(response, result.statusCode, result.body);
  } catch (error) {
    return sendJson(response, contributionErrorStatus(error), { error: error instanceof Error ? error.message : String(error) });
  }
}

async function processContributionQueue(tenantId: string, directory: string): Promise<void> {
  if (contributionQueueBusy.has(tenantId)) return;
  contributionQueueBusy.add(tenantId);
  try {
    const requestsDir = path.join(directory, 'requests');
    const responsesDir = path.join(directory, 'responses');
    for (const name of (await readdir(requestsDir)).filter(item => /^[a-f0-9-]+\.json$/.test(item)).sort()) {
      const requestFile = path.join(requestsDir, name);
      const responseFile = path.join(responsesDir, name);
      let result: ContributionBrokerResult;
      try {
        const info = await lstat(requestFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) throw new ContributionError('Invalid contribution queue request.');
        const request = JSON.parse(await readFile(requestFile, 'utf8')) as { version?: number; method?: string; pathname?: string; body?: unknown };
        if (request.version !== 1 || !['GET', 'POST'].includes(request.method ?? '') || typeof request.pathname !== 'string') {
          throw new ContributionError('Invalid contribution queue request.');
        }
        result = await executeContributionBrokerRequest(tenantId, request.method!, request.pathname, request.body);
      } catch (error) {
        result = { statusCode: contributionErrorStatus(error), body: { error: error instanceof Error ? error.message : String(error) } };
      }
      const temporary = `${responseFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(result), { mode: 0o666 });
      await rename(temporary, responseFile);
      await unlink(requestFile);
    }
  } finally {
    contributionQueueBusy.delete(tenantId);
  }
}

async function ensureContributionBroker(tenantId: string): Promise<void> {
  if (contributionBrokers.has(tenantId)) return;
  const directory = path.join(tenantsDir, tenantId, 'workspace', '.fleet-contribution');
  const socketPath = path.join(directory, 'broker.sock');
  await mkdir(directory, { recursive: true, mode: 0o775 });
  try { if (process.getuid?.() === 0) await chown(directory, 10001, 10001); }
  catch (error) { if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  const requestsDir = path.join(directory, 'requests');
  const responsesDir = path.join(directory, 'responses');
  await Promise.all([mkdir(requestsDir, { recursive: true, mode: 0o777 }), mkdir(responsesDir, { recursive: true, mode: 0o777 })]);
  await Promise.all([chmod(requestsDir, 0o777), chmod(responsesDir, 0o777)]);
  try { await unlink(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const broker = createServer((request, response) => { void handleContributionBroker(tenantId, request, response); });
  await new Promise<void>((resolve, reject) => {
    broker.once('error', reject);
    broker.listen(socketPath, () => { broker.off('error', reject); resolve(); });
  });
  let tenantOwned = false;
  try { if (process.getuid?.() === 0) { await chown(socketPath, 10001, 10001); tenantOwned = true; } }
  catch (error) { if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  await chmod(socketPath, tenantOwned ? 0o660 : 0o666);
  contributionBrokers.set(tenantId, broker);
  if (!contributionQueueTimers.has(tenantId)) {
    const timer = setInterval(() => { void processContributionQueue(tenantId, directory); }, 100);
    timer.unref();
    contributionQueueTimers.set(tenantId, timer);
  }
}

function normalizeContributionRepository(input: ContributionRepositoryInput): ContributionRepositoryInput {
  return {
    alias: input.alias.trim(),
    provider: input.provider,
    remote: input.remote.trim(),
    defaultBranch: input.defaultBranch.trim(),
    credentialRef: input.credentialRef.trim(),
    authorName: input.authorName.trim(),
    authorEmail: input.authorEmail.trim(),
    branchPrefix: input.branchPrefix.trim(),
    assignedTenants: [...new Set(input.assignedTenants)],
    protectedPaths: [...new Set(input.protectedPaths.map(item => item.trim()))],
    maxChangedFiles: input.maxChangedFiles,
    maxChangedBytes: input.maxChangedBytes,
    enabled: input.enabled,
  };
}

function contributionRepositoryAssignmentErrors(input: ContributionRepositoryInput, state: FleetState): string[] {
  const deploymentIds = new Set(state.deployments.map(deployment => deployment.id));
  return input.assignedTenants.filter(id => !deploymentIds.has(id)).map(id => `Assigned tenant does not exist: ${id}`);
}

async function renderContributionAssignments(state: FleetState, tenantIds: Iterable<string>): Promise<void> {
  const ids = new Set(tenantIds);
  await Promise.all(state.deployments
    .filter(deployment => ids.has(deployment.id))
    .map(deployment => renderTenant(deployment, state.contributionRepositories)));
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

  if (request.method === 'GET' && url.pathname === '/api/contribution-repositories') {
    const state = await readState();
    return sendJson(response, 200, { repositories: state.contributionRepositories });
  }

  if (request.method === 'POST' && url.pathname === '/api/contribution-repositories') {
    const body = await parseBody(request);
    const validation = validateContributionRepository(body, allowLocalContributionRemotes);
    if (!validation.valid) return sendJson(response, 422, { error: 'Invalid contribution repository.', errors: validation.errors });
    const input = normalizeContributionRepository(body as ContributionRepositoryInput);
    const state = await readState();
    const assignmentErrors = contributionRepositoryAssignmentErrors(input, state);
    if (assignmentErrors.length) return sendJson(response, 422, { error: 'Invalid tenant assignments.', errors: assignmentErrors });
    if (state.contributionRepositories.some(repository => repository.alias === input.alias)) {
      return sendJson(response, 409, { error: `A contribution repository with alias ${input.alias} already exists.` });
    }
    const now = new Date().toISOString();
    const repository: ContributionRepository = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    state.contributionRepositories.push(repository);
    state.activities.unshift(activity('contribution-repository', 'blue', `${repository.alias} registered`, `${repository.provider} · ${repository.assignedTenants.length} tenant assignments`));
    await renderContributionAssignments(state, repository.assignedTenants);
    await writeState(state);
    return sendJson(response, 201, { repository });
  }

  const contributionMatch = url.pathname.match(/^\/api\/contribution-repositories\/([a-f0-9-]+)$/);
  if (contributionMatch) {
    const state = await readState();
    const repositoryIndex = state.contributionRepositories.findIndex(repository => repository.id === contributionMatch[1]);
    if (repositoryIndex < 0) return sendJson(response, 404, { error: 'Contribution repository not found.' });
    const previous = state.contributionRepositories[repositoryIndex];
    if (request.method === 'PUT') {
      const body = await parseBody(request);
      const validation = validateContributionRepository(body, allowLocalContributionRemotes);
      if (!validation.valid) return sendJson(response, 422, { error: 'Invalid contribution repository.', errors: validation.errors });
      const input = normalizeContributionRepository(body as ContributionRepositoryInput);
      const assignmentErrors = contributionRepositoryAssignmentErrors(input, state);
      if (assignmentErrors.length) return sendJson(response, 422, { error: 'Invalid tenant assignments.', errors: assignmentErrors });
      if (state.contributionRepositories.some((repository, index) => index !== repositoryIndex && repository.alias === input.alias)) {
        return sendJson(response, 409, { error: `A contribution repository with alias ${input.alias} already exists.` });
      }
      const repository: ContributionRepository = { ...previous, ...input, updatedAt: new Date().toISOString() };
      state.contributionRepositories[repositoryIndex] = repository;
      state.activities.unshift(activity('contribution-repository', 'blue', `${repository.alias} updated`, `${repository.provider} · ${repository.assignedTenants.length} tenant assignments`));
      await renderContributionAssignments(state, [...previous.assignedTenants, ...repository.assignedTenants]);
      await writeState(state);
      return sendJson(response, 200, { repository });
    }
    if (request.method === 'DELETE') {
      state.contributionRepositories.splice(repositoryIndex, 1);
      state.activities.unshift(activity('contribution-repository', 'amber', `${previous.alias} removed`, `${previous.provider} contribution access removed`));
      await renderContributionAssignments(state, previous.assignedTenants);
      await writeState(state);
      return sendJson(response, 200, { repository: previous });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/deployments') {
    const body = await parseBody(request);
    const validation = validateTenantConfiguration(body);
    if (!validation.valid) return sendJson(response, 422, { error: 'Invalid tenant configuration.', errors: validation.errors });
    const config = body as TenantConfiguration;
    const state = await readState();
    if (state.deployments.some(item => item.id === config.slug)) return sendJson(response, 409, { error: 'A deployment with this slug already exists.' });
    const deployment = deploymentFromConfiguration(config);
    await renderTenant(deployment, state.contributionRepositories);
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

  if (request.method === 'POST' && suffix === 'contributions/prepare') {
    try {
      const body = await parseBody(request) as { repositoryId?: string; repository?: string; requestId?: string };
      const result = await prepareContribution(id, body.repositoryId ?? body.repository ?? '', body.requestId ?? '');
      return sendJson(response, result.created ? 201 : 200, { contribution: result.contribution });
    } catch (error) {
      return sendJson(response, contributionErrorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'GET' && suffix === 'contributions') {
    return sendJson(response, 200, { contributions: state.contributions.filter(item => item.tenantId === id) });
  }
  const contributionAction = suffix.match(/^contributions\/([a-f0-9-]+)(?:\/(publish|abort))?$/);
  if (contributionAction && request.method === 'GET' && !contributionAction[2]) {
    const contribution = state.contributions.find(item => item.id === contributionAction[1] && item.tenantId === id);
    return contribution ? sendJson(response, 200, { contribution }) : sendJson(response, 404, { error: 'Contribution not found.' });
  }
  if (contributionAction && request.method === 'POST' && contributionAction[2] === 'publish') {
    try {
      const body = await parseBody(request) as { expectedBaseSha?: string; message?: string; branch?: string };
      const contribution = await publishContribution(id, contributionAction[1], { expectedBaseSha: body.expectedBaseSha ?? '', message: body.message ?? '', branch: body.branch });
      return sendJson(response, 200, { contribution });
    } catch (error) {
      return sendJson(response, contributionErrorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (contributionAction && request.method === 'POST' && contributionAction[2] === 'abort') {
    try {
      await parseBody(request);
      return sendJson(response, 200, { contribution: await abortContribution(id, contributionAction[1]) });
    } catch (error) {
      return sendJson(response, contributionErrorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  }

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
    await renderTenant(updated, state.contributionRepositories);
    state.deployments[index] = updated;
    state.activities.unshift(activity('updated', 'blue', `${updated.name} configuration updated`, `${updated.adapter} · ${updated.provider}`, id));
    await writeState(state);
    return sendJson(response, 200, { deployment: updated });
  }

  if (request.method === 'GET' && suffix === 'compose') {
    const compose = await renderTenant(state.deployments[index], state.contributionRepositories);
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
    await renderTenant(state.deployments[index], state.contributionRepositories);
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
const startupState = await readState();
await Promise.all(startupState.deployments
  .filter(deployment => assignedContributionRepositories(deployment, startupState.contributionRepositories).length > 0)
  .map(deployment => ensureContributionBroker(deployment.id)));
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

export type AdapterType = 'slack' | 'discord';
export type ProviderType = 'copilot' | 'codex' | 'opencode';
export type EnvironmentName = 'Development' | 'Staging' | 'Production';
export type DeploymentStatus = 'healthy' | 'deploying' | 'attention' | 'suspended' | 'stopped';
export type ColorName = 'violet' | 'blue' | 'amber' | 'rose' | 'green';

export interface RepositorySnapshot {
  name: string;
  revision: string;
}

export type ContributionRepositoryProvider = 'bitbucket-cloud' | 'github' | 'local';

export interface ContributionRepository {
  id: string;
  alias: string;
  provider: ContributionRepositoryProvider;
  /** Provider identity (`owner/repository`) or an E2E-only absolute local path. */
  remote: string;
  defaultBranch: string;
  credentialRef: string;
  authorName: string;
  authorEmail: string;
  branchPrefix: string;
  assignedTenants: string[];
  protectedPaths: string[];
  maxChangedFiles: number;
  maxChangedBytes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ContributionRepositoryInput = Omit<ContributionRepository, 'id' | 'createdAt' | 'updatedAt'>;

export type ContributionStatus = 'prepared' | 'published' | 'aborted' | 'failed';

export interface Contribution {
  id: string;
  requestId: string;
  tenantId: string;
  repositoryId: string;
  repositoryAlias: string;
  baseSha: string;
  branch: string;
  /** Path exposed to the tenant assistant, never the controller's host path. */
  workspacePath: string;
  status: ContributionStatus;
  createdAt: string;
  updatedAt: string;
  publishedSha?: string;
  branchUrl?: string;
  pullRequestUrl?: string;
  validationSummary?: string;
  failureReason?: string;
}

export interface SecretEnvironmentVariable {
  name: string;
  reference: string;
}

export interface N8nRelayConfiguration {
  enabled: boolean;
  intakeUrl: string;
  intakeTokenRef: string;
  headerName: string;
  pollMs: string;
}

export interface TenantConfiguration {
  name: string;
  slug: string;
  environment: EnvironmentName;
  type: AdapterType;
  image: string;
  provider: ProviderType;
  model: string;
  teamId: string;
  installationId: string;
  allowedChannels: string;
  allowedUsers: string;
  slackAppTokenRef: string;
  slackBotTokenRef: string;
  discordAppId: string;
  discordGuildId: string;
  discordAllowedUsers: string;
  discordAdminUsers: string;
  discordTokenRef: string;
  freeChannels: string;
  securityMode: 'shared' | 'unrestricted';
  stateDir: string;
  workspaceRoot: string;
  configDir: string;
  systemPromptFile: string;
  browserUrl: string;
  registerCommands: boolean;
  attachmentMode: 'native' | 'text';
  participationMode: 'smart' | 'always' | 'mentions-only';
  suppressEmbeds: boolean;
  historyTokenRef: string;
  excludedSlackUsers: string;
  timeoutMs: string;
  progressIntervalMs: string;
  outputMaxBytes: string;
  inputMaxBytes: string;
  mcpConfigPath: string;
  openCodeBin: string;
  webSearchMode: 'disabled' | 'cached' | 'indexed' | 'live';
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  providerAuthMode: 'persisted-login' | 'secret-reference';
  providerSecretRef: string;
  providerSecretEnvName?: string;
  mediaTimeoutMs: string;
  cancellationGraceMs: string;
  schedulesEnabled: boolean;
  enableSites: boolean;
  enableGithubContributions: boolean;
  extraEnv: string;
  participationEvaluator: 'provider' | 'jev';
  participationReasoning: 'none' | 'low';
  participationTimeoutMs: string;
  searchCandidateLimit: string;
  searchContextLimit: string;
  memoryRecallLimit: string;
  /** Reuse an existing provider/state volume during an in-place migration. */
  dataVolumeName?: string;
  /** Use the fleet-owned tenants/<slug>/workspace directory as the writable workspace. */
  managedWorkspace?: boolean;
  /** Additional secret-backed environment variables required by the assistant. */
  secretEnvironment?: SecretEnvironmentVariable[];
  /** Optional tenant-local n8n content intake sidecar. */
  n8nRelay?: N8nRelayConfiguration;
}

export interface Deployment {
  id: string;
  name: string;
  monogram: string;
  color: ColorName;
  environment: EnvironmentName;
  status: DeploymentStatus;
  adapter: AdapterType;
  image: string;
  desiredImage: string;
  teamId: string;
  installationId: string;
  channels: number;
  users: number;
  volume: string;
  project: string;
  updated: string;
  latency: string;
  repositoryList: RepositorySnapshot[];
  sharedSkills: number;
  tenantSkills: number;
  storage: string;
  prompt: string;
  provider: 'Copilot' | 'Codex' | 'OpenCode';
  model?: string;
  tenantType?: AdapterType;
  configuration?: TenantConfiguration;
  progress?: number;
  issue?: string;
}

export type ActivityTone = 'green' | 'blue' | 'amber';

export interface ActivityRecord {
  id: string;
  kind: 'created' | 'updated' | 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback' | 'repository' | 'contribution-repository' | 'contribution' | 'error';
  tone: ActivityTone;
  title: string;
  detail: string;
  deploymentId?: string;
  createdAt: string;
}

export interface FleetState {
  deployments: Deployment[];
  activities: ActivityRecord[];
  contributionRepositories: ContributionRepository[];
  contributions: Contribution[];
}

export interface OperationResult {
  ok: boolean;
  action: string;
  deployment?: Deployment;
  output?: string;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateContributionRepository(value: unknown, allowLocal = false): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Contribution repository must be an object.'] };
  }
  const repository = value as Partial<ContributionRepositoryInput>;
  if (typeof repository.alias !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(repository.alias)) {
    errors.push('Alias must contain lowercase letters, numbers, and hyphens only.');
  }
  if (!['bitbucket-cloud', 'github', ...(allowLocal ? ['local'] : [])].includes(repository.provider ?? '')) {
    errors.push('Provider must be Bitbucket Cloud or GitHub.');
  }
  if (repository.provider === 'local') {
    if (!allowLocal || typeof repository.remote !== 'string' || !pathLikeAbsolute(repository.remote)) errors.push('Local remotes are available only to the E2E harness.');
  } else if (typeof repository.remote !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.remote)) {
    errors.push('Repository must use the owner/repository form without a URL or credentials.');
  }
  if (typeof repository.defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(repository.defaultBranch)
    || repository.defaultBranch.includes('..') || repository.defaultBranch.endsWith('/')) {
    errors.push('Default branch is invalid.');
  }
  if (typeof repository.branchPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(repository.branchPrefix)
    || repository.branchPrefix.includes('..') || ['main/', 'master/'].includes(repository.branchPrefix)) {
    errors.push('Branch prefix must be a safe namespace ending in /.');
  }
  if (typeof repository.credentialRef !== 'string'
    || (repository.provider !== 'local' && !/^(secret|env|file):\/\//.test(repository.credentialRef))) {
    errors.push('Credential reference must use secret://, env://, or file://.');
  }
  if (typeof repository.authorName !== 'string' || !repository.authorName.trim()) errors.push('Commit author name is required.');
  if (typeof repository.authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(repository.authorEmail)) errors.push('Commit author email is invalid.');
  if (!Array.isArray(repository.assignedTenants) || repository.assignedTenants.some(id => !/^[a-z0-9][a-z0-9-]*$/.test(id))) {
    errors.push('Assigned tenants must be tenant slugs.');
  }
  if (!Array.isArray(repository.protectedPaths) || repository.protectedPaths.some(item => typeof item !== 'string' || !item.trim())) {
    errors.push('Protected paths must be non-empty strings.');
  }
  if (!Number.isSafeInteger(repository.maxChangedFiles) || (repository.maxChangedFiles ?? 0) < 1 || (repository.maxChangedFiles ?? 0) > 500) {
    errors.push('Maximum changed files must be between 1 and 500.');
  }
  if (!Number.isSafeInteger(repository.maxChangedBytes) || (repository.maxChangedBytes ?? 0) < 1 || (repository.maxChangedBytes ?? 0) > 50_000_000) {
    errors.push('Maximum changed bytes must be between 1 and 50000000.');
  }
  if (typeof repository.enabled !== 'boolean') errors.push('Enabled must be true or false.');
  return { valid: errors.length === 0, errors };
}

function pathLikeAbsolute(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0');
}

export function validateTenantConfiguration(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['Configuration must be an object.'] };
  const config = value as Partial<TenantConfiguration>;
  const required = (key: keyof TenantConfiguration, label: string) => {
    if (typeof config[key] !== 'string' || !(config[key] as string).trim()) errors.push(`${label} is required.`);
  };
  required('name', 'Tenant name');
  required('slug', 'Tenant slug');
  required('image', 'Pinned image');
  if (config.slug && !/^[a-z0-9][a-z0-9-]*$/.test(config.slug)) errors.push('Tenant slug must contain lowercase letters, numbers, and hyphens only.');
  if (config.image?.endsWith(':latest')) errors.push('The application image must be pinned; :latest is not allowed.');
  if (config.type !== 'slack' && config.type !== 'discord') errors.push('Adapter must be slack or discord.');
  if (!['copilot', 'codex', 'opencode'].includes(config.provider ?? '')) errors.push('Provider must be copilot, codex, or opencode.');
  if (config.securityMode !== 'shared' && config.securityMode !== 'unrestricted') errors.push('Security mode is invalid.');
  if (config.type === 'slack') {
    required('teamId', 'Slack team ID');
    required('installationId', 'Slack installation ID');
    required('allowedChannels', 'Slack allowed channels');
    required('slackAppTokenRef', 'Slack app-token reference');
    required('slackBotTokenRef', 'Slack bot-token reference');
    if (config.securityMode !== 'shared') errors.push('Slack requires shared security mode.');
  }
  if (config.type === 'discord') {
    required('discordAppId', 'Discord application ID');
    required('discordGuildId', 'Discord guild ID');
    required('discordTokenRef', 'Discord bot-token reference');
  }
  if (config.providerAuthMode === 'secret-reference') required('providerSecretRef', 'Provider secret reference');
  if (config.dataVolumeName && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.dataVolumeName)) errors.push('Data volume name contains unsupported characters.');
  for (const secret of config.secretEnvironment ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(secret.name)) errors.push(`Invalid secret environment name: ${secret.name}`);
    if (!/^(secret|env|file):\/\//.test(secret.reference)) errors.push(`Invalid secret reference for ${secret.name}.`);
  }
  if (config.n8nRelay?.enabled) {
    if (!/^https:\/\//.test(config.n8nRelay.intakeUrl)) errors.push('n8n intake URL must use HTTPS.');
    if (!/^(secret|env|file):\/\//.test(config.n8nRelay.intakeTokenRef)) errors.push('n8n intake token must use a secret reference.');
    if (!/^\d+$/.test(config.n8nRelay.pollMs)) errors.push('n8n poll interval must be an integer in milliseconds.');
  }
  return { valid: errors.length === 0, errors };
}

export function deploymentFromConfiguration(config: TenantConfiguration): Deployment {
  const countIds = (value: string) => value ? value.split(',').map(item => item.trim()).filter(Boolean).length : 0;
  const monogram = config.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return {
    id: config.slug,
    name: config.name,
    monogram,
    color: 'green',
    environment: config.environment,
    status: 'suspended',
    adapter: config.type,
    image: config.image,
    desiredImage: config.image,
    teamId: config.type === 'slack' ? config.teamId : config.discordGuildId,
    installationId: config.type === 'slack' ? config.installationId : `${config.slug}-discord`,
    channels: config.type === 'slack' ? countIds(config.allowedChannels) : countIds(config.freeChannels),
    users: config.type === 'slack' ? countIds(config.allowedUsers) : countIds(config.discordAllowedUsers),
    volume: config.dataVolumeName ?? `assistant-${config.slug}-data`,
    project: `assistant-${config.slug}`,
    updated: 'Just now',
    latency: '—',
    repositoryList: [],
    sharedSkills: 0,
    tenantSkills: 0,
    storage: '0 MB',
    prompt: config.systemPromptFile,
    provider: config.provider === 'codex' ? 'Codex' : config.provider === 'copilot' ? 'Copilot' : 'OpenCode',
    model: config.model,
    tenantType: config.type,
    configuration: { ...config },
  };
}

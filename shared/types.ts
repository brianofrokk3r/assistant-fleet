export type AdapterType = 'slack' | 'discord';
export type ProviderType = 'copilot' | 'codex' | 'opencode';
export type EnvironmentName = 'Development' | 'Staging' | 'Production';
export type DeploymentStatus = 'healthy' | 'deploying' | 'attention' | 'suspended' | 'stopped';
export type ColorName = 'violet' | 'blue' | 'amber' | 'rose' | 'green';

export interface RepositorySnapshot {
  name: string;
  revision: string;
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
  kind: 'created' | 'updated' | 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback' | 'repository' | 'error';
  tone: ActivityTone;
  title: string;
  detail: string;
  deploymentId?: string;
  createdAt: string;
}

export interface FleetState {
  deployments: Deployment[];
  activities: ActivityRecord[];
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
    required('allowedUsers', 'Slack allowed users');
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

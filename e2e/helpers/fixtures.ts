export function slackTenant(slug = 'contribution-e2e') {
  return {
    name: 'Contribution E2E', slug, environment: 'Development', type: 'slack',
    image: 'ghcr.io/example/ai-assistant:1.0.0', provider: 'codex', model: '',
    teamId: 'T012345', installationId: `${slug}-installation`, allowedChannels: 'C012345',
    allowedUsers: 'U012345', slackAppTokenRef: 'env://E2E_SLACK_APP_TOKEN',
    slackBotTokenRef: 'env://E2E_SLACK_BOT_TOKEN', discordAppId: '', discordGuildId: '',
    discordAllowedUsers: '', discordAdminUsers: '', discordTokenRef: '', freeChannels: '',
    securityMode: 'shared', stateDir: '/data/adapter-state', workspaceRoot: '/data/workspaces',
    configDir: '/data', systemPromptFile: '/config/prompt.md', browserUrl: 'http://browser:3123',
    registerCommands: false, attachmentMode: 'native', participationMode: 'mentions-only',
    suppressEmbeds: true, historyTokenRef: '', excludedSlackUsers: '', timeoutMs: '600000',
    progressIntervalMs: '3000', outputMaxBytes: '10485760', inputMaxBytes: '10485760',
    mcpConfigPath: '', openCodeBin: 'opencode', webSearchMode: 'disabled', reasoningEffort: 'medium',
    providerAuthMode: 'persisted-login', providerSecretRef: '', mediaTimeoutMs: '30000',
    cancellationGraceMs: '5000', schedulesEnabled: false, enableSites: false,
    enableGithubContributions: false, extraEnv: '', participationEvaluator: 'provider',
    participationReasoning: 'none', participationTimeoutMs: '15000', searchCandidateLimit: '20',
    searchContextLimit: '10', memoryRecallLimit: '10', managedWorkspace: true,
  };
}

export function contributionRepository(overrides: Record<string, unknown> = {}) {
  return {
    alias: 'validation-api',
    provider: 'github',
    remote: 'rokk3rlabs/rokk3rx-validation-api',
    defaultBranch: 'main',
    credentialRef: 'env://CONTRIBUTION_E2E_REMOTE_TOKEN',
    authorName: 'Assistant Fleet',
    authorEmail: 'assistant-fleet@users.noreply.github.com',
    branchPrefix: 'assistant-e2e/',
    assignedTenants: ['contribution-e2e'],
    protectedPaths: ['.github/**', '.bitbucket/**'],
    maxChangedFiles: 30,
    maxChangedBytes: 1_000_000,
    enabled: true,
    ...overrides,
  };
}

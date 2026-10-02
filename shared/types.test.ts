import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentFromConfiguration, validateTenantConfiguration, type TenantConfiguration } from './types.ts';

const base = (): TenantConfiguration => ({
  name: 'Acme', slug: 'acme', environment: 'Staging', type: 'slack',
  image: 'ghcr.io/rubiss-projects/ai-assistant:v1.26.0', provider: 'opencode', model: 'openrouter/example',
  teamId: 'T012345', installationId: 'acme', allowedChannels: 'C012345', allowedUsers: 'U012345',
  slackAppTokenRef: 'secret://slack/acme/app-token', slackBotTokenRef: 'secret://slack/acme/bot-token',
  discordAppId: '', discordGuildId: '', discordAllowedUsers: '', discordAdminUsers: '',
  discordTokenRef: 'secret://discord/acme/bot-token', freeChannels: '', securityMode: 'shared',
  stateDir: '/data/adapter-state', workspaceRoot: '/data/workspaces', configDir: '/data',
  systemPromptFile: '/config/prompt.md', browserUrl: 'http://browser:3123', registerCommands: false,
  attachmentMode: 'native', participationMode: 'smart', suppressEmbeds: false, historyTokenRef: '',
  excludedSlackUsers: '', timeoutMs: '3600000', progressIntervalMs: '60000', outputMaxBytes: '10485760',
  inputMaxBytes: '104857600', mcpConfigPath: '', openCodeBin: 'opencode', webSearchMode: 'cached',
  reasoningEffort: 'low', providerAuthMode: 'persisted-login', providerSecretRef: '', mediaTimeoutMs: '300000',
  cancellationGraceMs: '5000', schedulesEnabled: false, enableSites: false,
  enableGithubContributions: false, extraEnv: '', participationEvaluator: 'provider',
  participationReasoning: 'none', participationTimeoutMs: '15000', searchCandidateLimit: '200',
  searchContextLimit: '50', memoryRecallLimit: '5',
});

test('Slack adapter and OpenCode provider remain independent', () => {
  const config = base();
  assert.equal(validateTenantConfiguration(config).valid, true);
  const deployment = deploymentFromConfiguration(config);
  assert.equal(deployment.adapter, 'slack');
  assert.equal(deployment.provider, 'OpenCode');
});

test('Slack user allowlist is optional', () => {
  const validation = validateTenantConfiguration({ ...base(), allowedUsers: '' });
  assert.equal(validation.valid, true);
});

test('Discord requires application, guild, and token reference', () => {
  const config = { ...base(), type: 'discord' as const, discordAppId: '', discordGuildId: '' };
  const validation = validateTenantConfiguration(config);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /Discord application ID/);
  assert.match(validation.errors.join(' '), /Discord guild ID/);
});

test('unpinned latest image is rejected', () => {
  const validation = validateTenantConfiguration({ ...base(), image: 'ghcr.io/rubiss-projects/ai-assistant:latest' });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /must be pinned/);
});

test('migration-only secret references and sidecars remain typed and external', () => {
  const config: TenantConfiguration = {
    ...base(),
    dataVolumeName: 'legacy_assistant-data',
    managedWorkspace: true,
    secretEnvironment: [{ name: 'TYPESAFE_API_KEY', reference: 'secret://typesafe/tenant/api-key' }],
    n8nRelay: {
      enabled: true,
      intakeUrl: 'https://example.invalid/webhook/intake',
      intakeTokenRef: 'secret://n8n/tenant/intake-token',
      headerName: 'X-Assistant-Token',
      pollMs: '15000',
    },
  };
  assert.equal(validateTenantConfiguration(config).valid, true);
  assert.equal(deploymentFromConfiguration(config).volume, 'legacy_assistant-data');
});

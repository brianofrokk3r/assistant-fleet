import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { contributionRepository, slackTenant } from './helpers/fixtures.ts';
import { createLocalGitRemote, startFleetHarness, type FleetHarness } from './helpers/fleet-harness.ts';

let fleet: FleetHarness;
let localRemote: string;
const run = promisify(execFile);

test.beforeAll(async () => {
  fleet = await startFleetHarness({
    E2E_SLACK_APP_TOKEN: 'not-used-by-rendering',
    E2E_SLACK_BOT_TOKEN: 'not-used-by-rendering',
    CONTRIBUTION_E2E_REMOTE_TOKEN: 'e2e-token-must-never-be-rendered',
    FLEET_E2E_ALLOW_LOCAL_REMOTES: 'true',
  });
  localRemote = await createLocalGitRemote(fleet.root);
  const tenant = await fetch(`${fleet.baseUrl}/api/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(slackTenant()),
  });
  expect(tenant.status).toBe(201);
  const secondTenant = await fetch(`${fleet.baseUrl}/api/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...slackTenant('contribution-e2e-two'), name: 'Second Agent' }),
  });
  expect(secondTenant.status).toBe(201);
});

test.afterAll(async () => {
  await fleet?.stop();
});

test('operator can register and assign a contribution repository through the UI', async ({ page, request }) => {
  await page.goto(`${fleet.baseUrl}/`);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('tab', { name: 'Contribution repositories' }).click();
  await page.getByRole('button', { name: 'Add contribution repository' }).first().click();
  await page.getByLabel('Provider', { exact: true }).selectOption('github');
  await page.getByLabel('Repository', { exact: true }).fill('rokk3rlabs/rokk3rx-validation-api');
  await page.getByLabel('Alias', { exact: true }).fill('validation-api');
  await page.getByLabel('Default branch', { exact: true }).fill('main');
  await page.getByLabel('Credential reference', { exact: true }).fill('env://CONTRIBUTION_E2E_REMOTE_TOKEN');
  await page.getByLabel('Branch prefix', { exact: true }).fill('assistant-e2e/');
  await page.getByLabel('Assigned tenants', { exact: true }).selectOption(['contribution-e2e']);
  await page.getByRole('button', { name: 'Save repository' }).click();

  await expect(page.getByText('rokk3rlabs/rokk3rx-validation-api')).toBeVisible();
  await expect(page.getByText('validation-api', { exact: true })).toBeVisible();
  await expect(page.getByText('Contribution E2E')).toBeVisible();
  await expect(page.getByText('env://CONTRIBUTION_E2E_REMOTE_TOKEN')).toBeVisible();
  await expect(page.getByText('e2e-token-must-never-be-rendered')).toHaveCount(0);

  await page.getByTitle('Edit repository').click();
  await page.getByLabel('Assigned tenants', { exact: true }).selectOption(['contribution-e2e', 'contribution-e2e-two']);
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByText('Second Agent')).toBeVisible();
  if (process.env.FLEET_E2E_SCREENSHOT) await page.screenshot({ path: process.env.FLEET_E2E_SCREENSHOT, fullPage: true });
});

test('one agent can retain multiple contribution repositories', async ({ request }) => {
  const first = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({ alias: 'agent-repository-one' }),
  });
  const second = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({ alias: 'agent-repository-two', remote: 'rokk3rlabs/another-validation-api' }),
  });
  expect(first.status()).toBe(201);
  expect(second.status()).toBe(201);
  const state = await (await request.get(`${fleet.baseUrl}/api/state`)).json() as {
    contributionRepositories: Array<{ alias: string; assignedTenants: string[] }>;
  };
  const assigned = state.contributionRepositories.filter(repository => repository.assignedTenants.includes('contribution-e2e'));
  expect(assigned.map(repository => repository.alias)).toEqual(expect.arrayContaining(['agent-repository-one', 'agent-repository-two']));
});

test('tenant-scoped client discovers assigned repositories through its Unix socket', async () => {
  const socket = path.join(fleet.root, 'tenants', 'contribution-e2e', 'workspace', '.fleet-contribution', 'broker.sock');
  const queue = path.dirname(socket);
  const result = await run(process.execPath, ['runtime/fleet-contribute.mjs', 'list'], {
    cwd: process.cwd(),
    env: { ...process.env, FLEET_CONTRIBUTION_SOCKET: socket },
  });
  const payload = JSON.parse(result.stdout) as { repositories: Array<{ alias: string; credentialRef?: string }> };
  expect(payload.repositories.some(repository => repository.alias === 'validation-api')).toBe(true);
  expect(payload.repositories.every(repository => repository.credentialRef === undefined)).toBe(true);

  const fallback = await run(process.execPath, ['runtime/fleet-contribute.mjs', 'list'], {
    cwd: process.cwd(),
    env: { ...process.env, FLEET_CONTRIBUTION_SOCKET: path.join(queue, 'unavailable.sock'), FLEET_CONTRIBUTION_QUEUE: queue },
  });
  expect((JSON.parse(fallback.stdout) as { repositories: Array<{ alias: string }> }).repositories.some(repository => repository.alias === 'validation-api')).toBe(true);
});

test('repository API rejects unsafe remotes and branch policies', async ({ request }) => {
  const credentialRemote = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({ remote: 'https://token@github.com/rokk3rlabs/rokk3rx-validation-api.git' }),
  });
  expect(credentialRemote.status()).toBe(422);

  const protectedPrefix = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({ alias: 'unsafe-prefix', branchPrefix: 'main' }),
  });
  expect(protectedPrefix.status()).toBe(422);
});

test('rendered state and Compose never contain a resolved remote credential', async ({ request }) => {
  const create = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({ alias: 'secret-redaction' }),
  });
  expect(create.status()).toBe(201);

  const state = await request.get(`${fleet.baseUrl}/api/state`);
  expect(await state.text()).not.toContain('e2e-token-must-never-be-rendered');

  const compose = await request.get(`${fleet.baseUrl}/api/deployments/contribution-e2e/compose`);
  expect(compose.status()).toBe(200);
  const rendered = await compose.text();
  expect(rendered).toContain('env://CONTRIBUTION_E2E_REMOTE_TOKEN');
  expect(rendered).not.toContain('e2e-token-must-never-be-rendered');
  expect(rendered).toContain('/usr/local/bin/fleet-contribute:ro');
  expect(rendered).toContain('/data/workspaces/contributions');
  expect(rendered).toContain('/data/workspaces/.fleet-contribution');

  const skill = await readFile(path.join(
    fleet.root, 'rendered-skillsets', 'contribution-e2e', 'fleet-contribute', 'SKILL.md',
  ), 'utf8');
  expect(skill).toContain('fleet-contribute ready <id>');
  expect(skill).toContain('has no external write side effect');
  expect(skill).toContain('Only the human action behind the approval URL');

  const prompt = await readFile(path.join(fleet.root, 'tenants', 'contribution-e2e', 'prompt.md'), 'utf8');
  expect(prompt).toContain('Return the resulting approval URL to the user.');
  expect(prompt).toContain('The agent must never publish directly');

  const persisted = await readFile(path.join(fleet.root, 'data', 'state.json'), 'utf8');
  expect(persisted).not.toContain('e2e-token-must-never-be-rendered');
});

test('prepare isolates concurrent contributions and sandbox publishing is unavailable', async ({ request }) => {
  const repository = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({
      alias: 'isolated-checkouts', provider: 'local', remote: localRemote, credentialRef: '',
    }),
  });
  expect(repository.status()).toBe(201);
  const record = await repository.json() as { repository: { id: string } };

  const first = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/prepare`, {
    data: { repositoryId: record.repository.id, requestId: 'first-request' },
  });
  const second = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/prepare`, {
    data: { repositoryId: record.repository.id, requestId: 'second-request' },
  });
  expect(first.status()).toBe(201);
  expect(second.status()).toBe(201);
  const a = await first.json() as { contribution: { id: string; branch: string; workspacePath: string } };
  const b = await second.json() as { contribution: { id: string; branch: string; workspacePath: string } };
  expect(a.contribution.id).not.toBe(b.contribution.id);
  expect(a.contribution.workspacePath).not.toBe(b.contribution.workspacePath);
  expect(a.contribution.branch).toMatch(/^assistant-e2e\//);
  expect(b.contribution.branch).toMatch(/^assistant-e2e\//);

  const publish = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/${a.contribution.id}/publish`, {
    data: { branch: 'main', expectedBaseSha: '0'.repeat(40), message: 'Unsafe target' },
  });
  expect(publish.status()).toBe(403);
  expect(await publish.text()).toContain('operator approval');
});

test('operator approval publishes the frozen README-only commit and reconciles retries', async ({ page, request }) => {
  const repository = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
    data: contributionRepository({
      alias: 'local-publish', provider: 'local', remote: localRemote, credentialRef: '',
    }),
  });
  expect(repository.status()).toBe(201);
  const record = await repository.json() as { repository: { id: string } };
  const prepare = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/prepare`, {
    data: { repositoryId: record.repository.id, requestId: 'publish-readme' },
  });
  expect(prepare.status()).toBe(201);
  const prepared = await prepare.json() as { contribution: {
    id: string; branch: string; baseSha: string; workspacePath: string;
  } };
  const checkout = path.join(
    fleet.root, 'tenants', 'contribution-e2e', 'workspace', 'contributions',
    'local-publish', prepared.contribution.id,
  );
  await appendFile(path.join(checkout, 'README.md'), '\nValidated by Assistant Fleet E2E.\n', 'utf8');

  const payload = {
    expectedBaseSha: prepared.contribution.baseSha,
    message: 'docs: validate contribution publishing',
  };
  const socket = path.join(fleet.root, 'tenants', 'contribution-e2e', 'workspace', '.fleet-contribution', 'broker.sock');
  const ready = await run(process.execPath, [
    'runtime/fleet-contribute.mjs', 'ready', prepared.contribution.id,
    '--base', payload.expectedBaseSha, '--message', payload.message,
  ], { cwd: process.cwd(), env: { ...process.env, FLEET_CONTRIBUTION_SOCKET: socket } });
  const readyResult = JSON.parse(ready.stdout) as { contribution: { status: string; preparedCommitSha: string }; approvalUrl: string };
  expect(readyResult.contribution.status).toBe('ready');
  expect(readyResult.approvalUrl).toMatch(new RegExp(`^${fleet.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/contributions/approve/`));
  await expect(run('git', [`--git-dir=${localRemote}`, 'rev-parse', `refs/heads/${prepared.contribution.branch}`])).rejects.toThrow();

  await page.goto(readyResult.approvalUrl);
  await expect(page.getByRole('heading', { name: 'local-publish' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish branch' })).toBeVisible();

  const token = new URL(readyResult.approvalUrl).pathname.split('/').at(-1)!;
  const stateAfterReady = await (await request.get(`${fleet.baseUrl}/api/state`)).text();
  expect(stateAfterReady).not.toContain(token);
  expect(stateAfterReady).not.toContain('approvalTokenHash');
  const publish = await request.post(`${fleet.baseUrl}/api/contribution-approvals/${token}/publish`, { data: {} });
  expect(publish.status()).toBe(200);
  const result = await publish.json() as { approval: { publishedSha: string; status: string; pullRequestUrl?: string } };
  expect(result.approval.status).toBe('published');
  const main = (await run('git', [`--git-dir=${localRemote}`, 'rev-parse', 'refs/heads/main'])).stdout.trim();
  const branch = (await run('git', [
    `--git-dir=${localRemote}`, 'rev-parse', `refs/heads/${prepared.contribution.branch}`,
  ])).stdout.trim();
  expect(main).toBe(prepared.contribution.baseSha);
  expect(branch).toBe(result.approval.publishedSha);

  const retry = await request.post(`${fleet.baseUrl}/api/contribution-approvals/${token}/publish`, { data: {} });
  expect(retry.status()).toBe(200);
  expect((await retry.json() as { approval: { publishedSha: string } }).approval.publishedSha).toBe(branch);
});

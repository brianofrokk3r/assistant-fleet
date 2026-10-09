import { expect, test } from '@playwright/test';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { contributionRepository, slackTenant } from './helpers/fixtures.ts';
import { startFleetHarness } from './helpers/fleet-harness.ts';

const live = process.env.FLEET_E2E_LIVE_REMOTE === 'true';
const token = process.env.CONTRIBUTION_E2E_REMOTE_TOKEN;

test('@live publishes a README-only branch to the validation repository', async ({ request }) => {
  test.skip(!live, 'Set FLEET_E2E_LIVE_REMOTE=true to allow a remote branch push.');
  test.skip(!token, 'Set CONTRIBUTION_E2E_REMOTE_TOKEN to a repository-scoped write token.');

  const fleet = await startFleetHarness({
    CONTRIBUTION_E2E_REMOTE_TOKEN: token,
    E2E_SLACK_APP_TOKEN: 'not-used-by-rendering',
    E2E_SLACK_BOT_TOKEN: 'not-used-by-rendering',
  });
  try {
    expect((await request.post(`${fleet.baseUrl}/api/deployments`, { data: slackTenant() })).status()).toBe(201);
    const createRepository = await request.post(`${fleet.baseUrl}/api/contribution-repositories`, {
      data: contributionRepository(),
    });
    expect(createRepository.status()).toBe(201);
    const repository = await createRepository.json() as { repository: { id: string } };

    const prepare = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/prepare`, {
      data: { repositoryId: repository.repository.id, requestId: `live-${Date.now()}` },
    });
    expect(prepare.status()).toBe(201);
    const prepared = await prepare.json() as { contribution: {
      id: string; baseSha: string; branch: string; workspacePath: string;
    } };
    expect(prepared.contribution.branch).toMatch(/^assistant-e2e\//);
    expect(prepared.contribution.workspacePath).toBe(
      `/data/workspaces/contributions/validation-api/${prepared.contribution.id}`,
    );

    const readme = path.join(
      fleet.root, 'tenants', 'contribution-e2e', 'workspace', 'contributions',
      'validation-api', prepared.contribution.id, 'README.md',
    );
    const marker = `\n<!-- assistant-fleet e2e validation ${prepared.contribution.id} -->\n`;
    await appendFile(readme, marker, 'utf8');
    expect(await readFile(readme, 'utf8')).toContain(marker.trim());

    const publish = await request.post(`${fleet.baseUrl}/api/deployments/contribution-e2e/contributions/${prepared.contribution.id}/publish`, {
      data: {
        expectedBaseSha: prepared.contribution.baseSha,
        message: 'docs: validate Assistant Fleet contribution publishing',
      },
    });
    expect(publish.status()).toBe(200);
    const result = await publish.json() as { contribution: {
      status: string; branch: string; publishedSha: string; branchUrl: string; pullRequestUrl: string;
    } };
    expect(result.contribution.status).toBe('published');
    expect(result.contribution.publishedSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.contribution.branchUrl).toContain('github.com/rokk3rlabs/rokk3rx-validation-api');
    expect(result.contribution.pullRequestUrl).toContain('github.com/rokk3rlabs/rokk3rx-validation-api');
  } finally {
    await fleet.stop();
  }
});

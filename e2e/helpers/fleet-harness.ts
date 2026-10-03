import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface FleetHarness {
  baseUrl: string;
  root: string;
  stop(): Promise<void>;
}

const run = promisify(execFile);

export async function createLocalGitRemote(root: string): Promise<string> {
  const source = path.join(root, 'fixtures', 'validation-api-source');
  const remote = path.join(root, 'fixtures', 'validation-api.git');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'README.md'), '# Validation API\n\nE2E fixture repository.\n', 'utf8');
  await run('git', ['init', '--initial-branch=main'], { cwd: source });
  await run('git', ['config', 'user.name', 'Assistant Fleet E2E'], { cwd: source });
  await run('git', ['config', 'user.email', 'assistant-fleet-e2e@example.invalid'], { cwd: source });
  await run('git', ['add', 'README.md'], { cwd: source });
  await run('git', ['commit', '-m', 'Initial fixture'], { cwd: source });
  await run('git', ['clone', '--bare', source, remote], { cwd: root });
  return remote;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate an E2E port.'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fleet API exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its socket.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fleet API did not become healthy within 15 seconds.');
}

export async function startFleetHarness(extraEnv: NodeJS.ProcessEnv = {}): Promise<FleetHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assistant-fleet-e2e-'));
  await Promise.all(['data', 'tenants', 'rendered-skillsets', 'repository-snapshots', 'secrets']
    .map(directory => mkdir(path.join(root, directory), { recursive: true })));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
      FLEET_ROOT: root,
      FLEET_UI_DIR: path.join(process.cwd(), 'dist'),
      FLEET_BIND_HOST: '127.0.0.1',
      FLEET_PORT: String(port),
      FLEET_DOCKER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(baseUrl, child);
  return {
    baseUrl,
    root,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Contribution, ContributionRepository } from '../shared/types.ts';

const gitEnvironment: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};
const askpassPath = fileURLToPath(new URL('./git-askpass.sh', import.meta.url));

export class ContributionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface ContributionRuntimeOptions {
  tenantsDir: string;
  resolveSecret(reference: string): Promise<{ value: string }>;
}

interface GitResult { stdout: string; stderr: string }

function providerRemote(repository: ContributionRepository): string {
  if (repository.provider === 'local') return repository.remote;
  if (repository.provider === 'github') return `https://github.com/${repository.remote}.git`;
  return `https://bitbucket.org/${repository.remote}.git`;
}

function providerUsername(repository: ContributionRepository): string {
  return repository.provider === 'github' ? 'x-access-token' : 'x-token-auth';
}

function publicUrls(repository: ContributionRepository, branch: string): { branchUrl?: string; pullRequestUrl?: string } {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  if (repository.provider === 'github') {
    return {
      branchUrl: `https://github.com/${repository.remote}/tree/${encodedBranch}`,
      pullRequestUrl: `https://github.com/${repository.remote}/compare/${encodeURIComponent(repository.defaultBranch)}...${encodedBranch}?expand=1`,
    };
  }
  if (repository.provider === 'bitbucket-cloud') {
    return {
      branchUrl: `https://bitbucket.org/${repository.remote}/src/${encodedBranch}/`,
      pullRequestUrl: `https://bitbucket.org/${repository.remote}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(repository.defaultBranch)}`,
    };
  }
  return {};
}

function matchesProtectedPath(file: string, patterns: string[]): boolean {
  return patterns.some(raw => {
    const pattern = raw.replace(/^\.\//, '');
    if (pattern.endsWith('/**')) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith('/*')) return file.startsWith(pattern.slice(0, -1));
    return file === pattern || file.startsWith(`${pattern}/`);
  });
}

async function makeWritable(target: string, checkoutRoot = target): Promise<void> {
  const info = await lstat(target);
  if (target === path.join(checkoutRoot, '.git')) return;
  let tenantOwned = false;
  if (process.getuid?.() === 0) {
    try { await chown(target, 10001, 10001); tenantOwned = true; }
    catch (error) { if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  if (!info.isSymbolicLink()) {
    const executable = Boolean(info.mode & 0o111);
    await chmod(target, info.isDirectory() ? (tenantOwned ? 0o775 : 0o777) : (executable ? 0o775 : (tenantOwned ? 0o664 : 0o666)));
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await makeWritable(path.join(target, entry), checkoutRoot);
  }
}

export class ContributionRuntime {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly options: ContributionRuntimeOptions;

  constructor(options: ContributionRuntimeOptions) { this.options = options; }

  checkoutPath(contribution: Pick<Contribution, 'tenantId' | 'repositoryAlias' | 'id'>): string {
    return path.join(this.options.tenantsDir, contribution.tenantId, 'workspace', 'contributions', contribution.repositoryAlias, contribution.id);
  }

  async locked<T>(repositoryId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(repositoryId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(action);
    this.locks.set(repositoryId, current);
    try { return await current; }
    finally { if (this.locks.get(repositoryId) === current) this.locks.delete(repositoryId); }
  }

  private async authEnvironment(repository: ContributionRepository): Promise<{ env: NodeJS.ProcessEnv; cleanup(): Promise<void>; token?: string }> {
    if (repository.provider === 'local') return { env: gitEnvironment, cleanup: async () => undefined };
    const { value } = await this.options.resolveSecret(repository.credentialRef);
    return {
      env: { ...gitEnvironment, GIT_ASKPASS: askpassPath, FLEET_GIT_USERNAME: providerUsername(repository), FLEET_GIT_TOKEN: value },
      token: value,
      cleanup: async () => undefined,
    };
  }

  private async git(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnvironment): Promise<GitResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', ['-c', `safe.directory=${cwd}`, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], {
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-256_000);
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
      child.once('error', reject);
      child.once('close', code => {
        const token = env.FLEET_GIT_TOKEN;
        const rawOutput = stderr || stdout;
        const sanitized = (token ? rawOutput.replaceAll(token, '[REDACTED]') : rawOutput).trim().slice(-2_000);
        return code === 0
          ? resolve({ stdout, stderr })
          : reject(new ContributionError(`Git operation failed (${args[0]}): ${sanitized}`, 502));
      });
    });
  }

  async prepare(tenantId: string, repository: ContributionRepository, requestId: string): Promise<Contribution> {
    if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new ContributionError('requestId must be 1-128 path-safe characters.');
    }
    const id = crypto.randomUUID();
    const branch = `${repository.branchPrefix}${id.slice(0, 12)}`;
    const contribution: Contribution = {
      id,
      requestId,
      tenantId,
      repositoryId: repository.id,
      repositoryAlias: repository.alias,
      baseSha: '',
      branch,
      workspacePath: `/data/workspaces/contributions/${repository.alias}/${id}`,
      status: 'prepared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const checkout = this.checkoutPath(contribution);
    await mkdir(path.dirname(checkout), { recursive: true, mode: 0o775 });
    const auth = await this.authEnvironment(repository);
    try {
      await this.git(path.dirname(checkout), ['clone', '--no-tags', '--single-branch', '--branch', repository.defaultBranch, '--', providerRemote(repository), checkout], auth.env);
      const baseSha = (await this.git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new ContributionError('Remote returned an invalid base commit.');
      await this.git(checkout, ['config', 'user.name', repository.authorName]);
      await this.git(checkout, ['config', 'user.email', repository.authorEmail]);
      await this.git(checkout, ['config', 'core.hooksPath', '/dev/null']);
      await this.git(checkout, ['switch', '-c', branch]);
      const tracked = (await this.git(checkout, ['ls-files', '-s'])).stdout;
      if (/^(120000|160000) /m.test(tracked)) throw new ContributionError('Repositories containing symlinks or submodules are not eligible for contributions.');
      contribution.baseSha = baseSha;
      await makeWritable(checkout);
      return contribution;
    } catch (error) {
      await rm(checkout, { recursive: true, force: true });
      throw error;
    } finally {
      await auth.cleanup();
    }
  }

  async ready(contribution: Contribution, repository: ContributionRepository, input: { expectedBaseSha: string; message: string }): Promise<Contribution> {
    if (contribution.status === 'ready') {
      if (input.expectedBaseSha !== contribution.baseSha || input.message?.trim() !== contribution.commitMessage) {
        throw new ContributionError('Ready contribution approval can only be renewed with its original base SHA and commit message.', 409);
      }
      return contribution;
    }
    if (contribution.status !== 'prepared') throw new ContributionError(`Contribution is ${contribution.status}, not prepared.`, 409);
    if (input.expectedBaseSha !== contribution.baseSha) throw new ContributionError('The expected base SHA does not match the prepared checkout.', 409);
    if (!input.message?.trim() || input.message.length > 200 || /[\0\r\n]/.test(input.message)) throw new ContributionError('Commit message must be 1-200 characters on one line.');
    if (!contribution.branch.startsWith(repository.branchPrefix) || contribution.branch === repository.defaultBranch) {
      throw new ContributionError('Contribution branch violates repository policy.');
    }

    const checkout = this.checkoutPath(contribution);
    const expectedRemote = providerRemote(repository);
    const configuredRemote = (await this.git(checkout, ['remote', 'get-url', 'origin'])).stdout.trim();
    if (configuredRemote !== expectedRemote) throw new ContributionError('Checkout remote changed after preparation.', 409);
    const head = (await this.git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
    const currentBranch = (await this.git(checkout, ['branch', '--show-current'])).stdout.trim();
    if (head !== contribution.baseSha || currentBranch !== contribution.branch) throw new ContributionError('Checkout base or branch changed after preparation.', 409);
    await this.git(checkout, ['add', '--all']);
    const changed = (await this.git(checkout, ['diff', '--cached', '--name-only', '-z', contribution.baseSha])).stdout.split('\0').filter(Boolean);
    if (!changed.length) throw new ContributionError('Contribution contains no changes.');
    if (changed.length > repository.maxChangedFiles) throw new ContributionError(`Contribution changes ${changed.length} files; limit is ${repository.maxChangedFiles}.`);
    const protectedFile = changed.find(file => matchesProtectedPath(file, repository.protectedPaths));
    if (protectedFile) throw new ContributionError(`Protected path cannot be changed: ${protectedFile}`);

    let changedBytes = 0;
    for (const file of changed) {
      const absolute = path.resolve(checkout, file);
      if (!absolute.startsWith(`${checkout}${path.sep}`)) throw new ContributionError(`Unsafe changed path: ${file}`);
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new ContributionError(`Symlinks cannot be contributed: ${file}`);
        if (info.isFile()) changedBytes += info.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (changedBytes > repository.maxChangedBytes) throw new ContributionError(`Contribution changes ${changedBytes} bytes; limit is ${repository.maxChangedBytes}.`);
    const stagedModes = (await this.git(checkout, ['ls-files', '-s', '--', ...changed])).stdout;
    if (/^(120000|160000) /m.test(stagedModes)) throw new ContributionError('Symlinks and submodules cannot be contributed.');

    const auth = await this.authEnvironment(repository);
    try {
      if (auth.token) {
        for (const file of changed) {
          try {
            const content = await readFile(path.join(checkout, file));
            if (content.includes(Buffer.from(auth.token))) throw new ContributionError(`Credential material detected in changed file: ${file}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      const remoteBase = (await this.git(checkout, ['ls-remote', '--exit-code', 'origin', `refs/heads/${repository.defaultBranch}`], auth.env)).stdout.trim().split(/\s+/)[0];
      if (remoteBase !== contribution.baseSha) throw new ContributionError('The remote default branch changed after preparation; prepare a new contribution.', 409);
      const remoteBranch = (await this.git(checkout, ['ls-remote', 'origin', `refs/heads/${contribution.branch}`], auth.env)).stdout.trim();
      if (remoteBranch) throw new ContributionError('The generated contribution branch already exists remotely.', 409);
      await this.git(checkout, ['commit', '-m', input.message.trim()]);
      const preparedCommitSha = (await this.git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
      return {
        ...contribution,
        status: 'ready',
        commitMessage: input.message.trim(),
        preparedCommitSha,
        changedFiles: changed,
        changedBytes,
        validationSummary: `${changed.length} file(s), ${changedBytes} byte(s) validated and committed locally for approval.`,
        updatedAt: new Date().toISOString(),
      };
    } finally {
      await auth.cleanup();
    }
  }

  async publish(contribution: Contribution, repository: ContributionRepository): Promise<Contribution> {
    if (contribution.status === 'published') return contribution;
    if (contribution.status !== 'ready') throw new ContributionError(`Contribution is ${contribution.status}, not ready for approval.`, 409);
    if (!contribution.preparedCommitSha || !contribution.commitMessage) throw new ContributionError('Ready contribution metadata is incomplete.', 409);
    if (!contribution.branch.startsWith(repository.branchPrefix) || contribution.branch === repository.defaultBranch) {
      throw new ContributionError('Contribution branch violates repository policy.');
    }

    const checkout = this.checkoutPath(contribution);
    const expectedRemote = providerRemote(repository);
    const configuredRemote = (await this.git(checkout, ['remote', 'get-url', 'origin'])).stdout.trim();
    if (configuredRemote !== expectedRemote) throw new ContributionError('Checkout remote changed after approval was requested.', 409);
    const head = (await this.git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
    const currentBranch = (await this.git(checkout, ['branch', '--show-current'])).stdout.trim();
    const worktree = (await this.git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim();
    if (head !== contribution.preparedCommitSha || currentBranch !== contribution.branch || worktree) {
      throw new ContributionError('Checkout changed after approval was requested; prepare a new contribution.', 409);
    }

    const auth = await this.authEnvironment(repository);
    try {
      const remoteBase = (await this.git(checkout, ['ls-remote', '--exit-code', 'origin', `refs/heads/${repository.defaultBranch}`], auth.env)).stdout.trim().split(/\s+/)[0];
      if (remoteBase !== contribution.baseSha) throw new ContributionError('The remote default branch changed after preparation; prepare a new contribution.', 409);
      const remoteBranch = (await this.git(checkout, ['ls-remote', 'origin', `refs/heads/${contribution.branch}`], auth.env)).stdout.trim();
      if (remoteBranch) throw new ContributionError('The generated contribution branch already exists remotely.', 409);
      await this.git(checkout, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${contribution.branch}`], auth.env);
      const urls = publicUrls(repository, contribution.branch);
      return {
        ...contribution,
        ...urls,
        status: 'published',
        publishedSha: contribution.preparedCommitSha,
        validationSummary: `${contribution.changedFiles?.length ?? 0} file(s), ${contribution.changedBytes ?? 0} byte(s) validated and pushed after operator approval.`,
        updatedAt: new Date().toISOString(),
      };
    } finally {
      await auth.cleanup();
    }
  }

  async abort(contribution: Contribution): Promise<Contribution> {
    if (contribution.status === 'aborted') return contribution;
    if (contribution.status === 'published') throw new ContributionError('Published contributions cannot be aborted.', 409);
    await rm(this.checkoutPath(contribution), { recursive: true, force: true });
    return { ...contribution, status: 'aborted', updatedAt: new Date().toISOString() };
  }
}

import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [
  spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, FLEET_PORT: '8787', FLEET_SERVE_STATIC: 'false' } }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:client'], { stdio: 'inherit' }),
];

const stop = (signal: NodeJS.Signals) => {
  for (const child of children) child.kill(signal);
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => stop('SIGTERM'));

const [code] = await Promise.race(children.map(child => new Promise<[number, NodeJS.Signals | null]>(resolve => child.on('exit', (exitCode, signal) => resolve([exitCode ?? 1, signal])))));
stop('SIGTERM');
process.exitCode = code;

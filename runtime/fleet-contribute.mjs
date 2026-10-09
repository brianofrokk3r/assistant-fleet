#!/usr/bin/env node
import http from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const socketPath = process.env.FLEET_CONTRIBUTION_SOCKET || '/data/workspaces/.fleet-contribution/broker.sock';
const queuePath = process.env.FLEET_CONTRIBUTION_QUEUE || '/data/workspaces/.fleet-contribution';

function usage() {
  process.stderr.write(`Usage:
  fleet-contribute list
  fleet-contribute prepare <repository-alias> [--request-id <id>]
  fleet-contribute status [contribution-id]
  fleet-contribute ready <contribution-id> --base <sha> --message <message>
  fleet-contribute abort <contribution-id>
`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestOnce(method, pathname, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: pathname, headers: payload ? {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    } : undefined }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let result;
        try { result = text ? JSON.parse(text) : {}; }
        catch { return reject(new Error(`Contribution broker returned invalid JSON (${response.statusCode}).`)); }
        if ((response.statusCode || 500) >= 400) return reject(new Error(result.error || `Contribution broker returned ${response.statusCode}.`));
        resolve(result);
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function request(method, pathname, body) {
  try { return await requestOnce(method, pathname, body); }
  catch (error) {
    if (!new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPERM', 'EACCES']).has(error?.code)) throw error;
  }

  const id = randomUUID();
  const requests = path.join(queuePath, 'requests');
  const responses = path.join(queuePath, 'responses');
  await Promise.all([mkdir(requests, { recursive: true }), mkdir(responses, { recursive: true })]);
  const pending = path.join(requests, `${id}.tmp`);
  const requestFile = path.join(requests, `${id}.json`);
  const responseFile = path.join(responses, `${id}.json`);
  await writeFile(pending, JSON.stringify({ version: 1, method, pathname, body }), { mode: 0o600 });
  await rename(pending, requestFile);
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responseFile, 'utf8'));
      await unlink(responseFile).catch(() => undefined);
      if (response.statusCode >= 400) throw new Error(response.body?.error || `Contribution broker returned ${response.statusCode}.`);
      return response.body;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await unlink(requestFile).catch(() => undefined);
  throw new Error(`Contribution broker timed out using workspace queue ${queuePath}.`);
}

const [, , command, subject] = process.argv;
try {
  let result;
  if (command === 'list') result = await request('GET', '/repositories');
  else if (command === 'prepare' && subject) result = await request('POST', '/prepare', {
    repository: subject,
    requestId: option('--request-id') || `cli-${Date.now()}`,
  });
  else if (command === 'status') result = await request('GET', subject ? `/contributions/${encodeURIComponent(subject)}` : '/contributions');
  else if (command === 'ready' && subject && option('--base') && option('--message')) result = await request('POST', `/contributions/${encodeURIComponent(subject)}/ready`, {
    expectedBaseSha: option('--base'),
    message: option('--message'),
  });
  else if (command === 'publish') throw new Error('Publishing requires operator approval through the Fleet review link returned by fleet-contribute ready.');
  else if (command === 'abort' && subject) result = await request('POST', `/contributions/${encodeURIComponent(subject)}/abort`, {});
  else { usage(); process.exitCode = 2; }
  if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

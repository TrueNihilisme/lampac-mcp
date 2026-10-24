import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const ACCEPT = 'application/json, text/event-stream';
const VERSION = '2025-11-25';

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function launch(t, writes = false) {
  const port = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lampac-mcp-test-'));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_TOKEN: token,
      ALLOWED_ORIGINS: 'https://client.example',
      MCP_ENABLE_WRITES: String(writes),
      COLLECTIONS_FILE: path.join(dir, 'collection.json'),
      LAMPAC_URL: '',
      LAMPAC_ROOT_PASSWORD: '',
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, `server did not start: ${stderr}`);

  return { base, token };
}

async function rpc(base, token, message, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': VERSION,
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

test('MCP requires bearer auth and rejects disallowed Origin', async (t) => {
  const { base, token } = await launch(t);
  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Accept: ACCEPT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(unauthorized.status, 401);

  const forbidden = await rpc(base, token, { jsonrpc: '2.0', id: 2, method: 'ping' }, { Origin: 'https://not-allowed.example' });
  assert.equal(forbidden.status, 403);
});

test('Streamable HTTP initializes, lists tools, serves the plugin, and keeps writes disabled by default', async (t) => {
  const { base, token } = await launch(t);
  const initialized = await rpc(base, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.protocolVersion, VERSION);

  const listing = await rpc(base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await listing.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['get_ai_collection', 'replace_ai_collection', 'inspect_title_sources', 'get_tvctl_log']);

  const read = await rpc(base, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_ai_collection', arguments: {} } });
  assert.equal((await read.json()).result.structuredContent.title, 'AI picks');

  const write = await rpc(base, token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'replace_ai_collection', arguments: { title: 'Picks', items: [], approval_phrase: 'I have reviewed and approve replacing the AI collection.' } },
  });
  assert.equal((await write.json()).result.isError, true);

  const plugin = await fetch(`${base}/plugin.js`);
  assert.equal(plugin.status, 200);
  assert.match(await plugin.text(), /ContentRows\.add/);
});

test('approved collection replacement persists only normalized card fields', async (t) => {
  const { base, token } = await launch(t, true);
  const response = await rpc(base, token, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'replace_ai_collection',
      arguments: {
        title: 'Weekend picks',
        items: [{ id: 42, media_type: 'movie', title: 'Example', unexpected: 'discard me' }],
        approval_phrase: 'I have reviewed and approve replacing the AI collection.',
      },
    },
  });
  const result = (await response.json()).result;
  assert.equal(result.isError, true);

  const valid = await rpc(base, token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'replace_ai_collection',
      arguments: {
        title: 'Weekend picks',
        items: [{ id: 42, media_type: 'movie', title: 'Example', poster_path: '/poster.jpg' }],
        approval_phrase: 'I have reviewed and approve replacing the AI collection.',
      },
    },
  });
  assert.deepEqual((await valid.json()).result.structuredContent, { ok: true, title: 'Weekend picks', items: 1 });

  const feed = await fetch(`${base}/api/collection`);
  const collection = await feed.json();
  assert.equal(collection.title, 'Weekend picks');
  assert.deepEqual(collection.items[0], {
    id: 42, media_type: 'movie', title: 'Example', source: 'tmdb', poster_path: '/poster.jpg',
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const APPROVAL = 'I have reviewed and approve changing the AI rows.';

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function launch(t, writes = false, initial = null) {
  const port = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lampac-mcp-test-'));
  const token = randomBytes(32).toString('hex');
  if (initial) await writeFile(path.join(dir, 'collection.json'), JSON.stringify(initial));
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
  assert.deepEqual(names, ['get_ai_rows', 'set_ai_row', 'delete_ai_row', 'inspect_title_sources', 'get_tvctl_log']);

  const read = await rpc(base, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_ai_rows', arguments: {} } });
  assert.deepEqual((await read.json()).result.structuredContent.rows, []);

  const write = await rpc(base, token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'set_ai_row', arguments: { id: 'picks', title: 'Picks', kind: 'movies', style: 'poster', items: [], approval_phrase: APPROVAL } },
  });
  assert.equal((await write.json()).result.isError, true);

  const plugin = await fetch(`${base}/plugin.js`);
  assert.equal(plugin.status, 200);
  assert.match(await plugin.text(), /sources\.tmdb/);

  const feed = await fetch(`${base}/api/collection`, { headers: { Origin: 'https://lampa.example' } });
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('access-control-allow-origin'), '*');
});

test('approved row writes keep order, normalize cards and support delete', async (t) => {
  const { base, token } = await launch(t, true);
  const call = async (name, args) => (await (await rpc(base, token, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  })).json()).result;

  const bad = await call('set_ai_row', {
    id: 'films', title: 'Films', kind: 'movies', style: 'poster', approval_phrase: APPROVAL,
    items: [{ id: 42, media_type: 'movie', title: 'Example', unexpected: 'discard me' }],
  });
  assert.equal(bad.isError, true);

  const films = await call('set_ai_row', {
    id: 'films', title: 'Films', kind: 'movies', style: 'poster', approval_phrase: APPROVAL,
    items: [{ id: 42, media_type: 'movie', title: 'Example', poster_path: '/poster.jpg' }],
  });
  assert.deepEqual(films.structuredContent, { ok: true, id: 'films', position: 0, items: 1, rows: 1 });
  await call('set_ai_row', { id: 'series', title: 'Series', kind: 'series', style: 'wide', items: [], approval_phrase: APPROVAL });
  const moved = await call('set_ai_row', { id: 'series', title: 'Series', kind: 'series', style: 'wide', position: 0, items: [], approval_phrase: APPROVAL });
  assert.equal(moved.structuredContent.position, 0);

  let feed = await (await fetch(`${base}/api/collection`)).json();
  assert.deepEqual(feed.rows.map((r) => [r.id, r.kind, r.style]), [['series', 'series', 'wide'], ['films', 'movies', 'poster']]);
  assert.equal(feed.title, 'Series');
  assert.deepEqual(feed.rows[1].items[0], { id: 42, media_type: 'movie', title: 'Example', source: 'tmdb', poster_path: '/poster.jpg' });

  assert.equal((await call('delete_ai_row', { id: 'series', approval_phrase: APPROVAL })).structuredContent.rows, 1);
  feed = await (await fetch(`${base}/api/collection`)).json();
  assert.deepEqual(feed.rows.map((r) => r.id), ['films']);
});

test('a collection file from the first alpha is read as one wide row', async (t) => {
  const { base } = await launch(t, false, { title: 'Old picks', items: [{ id: 7, media_type: 'tv', title: 'Old', source: 'tmdb' }] });
  const feed = await (await fetch(`${base}/api/collection`)).json();
  assert.equal(feed.title, 'Old picks');
  assert.deepEqual(feed.rows.map((r) => [r.id, r.style, r.items.length]), [['ai-picks', 'wide', 1]]);
});

test('local CUB stand-in answers without forwarding and logs paths only', async (t) => {
  const { base } = await launch(t);

  const discuss = await fetch(`${base}/cub/api/discuss/get/tv_209867/1/uk`);
  assert.equal(discuss.status, 404);

  const plugin = await fetch(`${base}/cub/plugin/shots`);
  assert.equal(plugin.status, 200);
  assert.match(plugin.headers.get('content-type'), /javascript/);

  const logs = await fetch(`${base}/cub/api/lampa/logs/write`, { method: 'POST', body: 'x'.repeat(2048) });
  assert.equal(logs.status, 200);
  assert.deepEqual(await logs.json(), { secuses: true });

  await fetch(`${base}/cub/api/reactions/get/movie_1?uid=device-secret`);
  const log = await (await fetch(`${base}/api/cub-log`)).json();
  const paths = log.requests.map((r) => r.path);
  assert.deepEqual(paths, ['/api/discuss/get/tv_209867/1/uk', '/plugin/shots', '/api/lampa/logs/write', '/api/reactions/get/movie_1']);
  assert.equal(JSON.stringify(log).includes('device-secret'), false);
});

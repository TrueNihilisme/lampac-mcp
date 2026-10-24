import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Fake Groq / Gemini / TMDB: the model proposes two real titles and one invented one.
async function fakes(t) {
  const seen = [];
  const { server, base } = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}`);
    const send = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const proposal = JSON.stringify({ items: [
      { original_title: 'Real Movie', year: 2020, type: 'movie' },
      { original_title: 'Invented Title', year: 2021, type: 'movie' },
      { original_title: 'Real Show', year: 2019, type: 'tv' },
    ] });
    if (url.pathname === '/groq/models') return send({ data: [{ id: 'model-b' }, { id: 'model-a' }] });
    if (url.pathname === '/groq/chat/completions') return send({ choices: [{ message: { content: proposal } }] });
    if (url.pathname === '/gemini/models') return send({ models: [{ name: 'models/g-1', supportedGenerationMethods: ['generateContent'] }] });
    if (url.pathname.startsWith('/gemini/models/') && url.pathname.endsWith(':generateContent')) {
      return send({ candidates: [{ content: { parts: [{ text: proposal }] } }] });
    }
    if (url.pathname.startsWith('/tmdb/search/')) {
      const q = url.searchParams.get('query');
      if (q === 'Real Movie' && url.pathname.endsWith('/movie')) return send({ results: [{ id: 11, title: 'Справжній фільм', original_title: 'Real Movie', poster_path: '/m.jpg', release_date: '2020-05-01' }] });
      if (q === 'Real Show' && url.pathname.endsWith('/tv')) return send({ results: [{ id: 22, name: 'Справжній серіал', original_name: 'Real Show', poster_path: '/s.jpg', first_air_date: '2019-01-01' }] });
      return send({ results: [] });
    }
    res.writeHead(404); res.end();
  });
  t.after(() => server.close());
  return { base, seen };
}

async function launch(t, fake, extraEnv = {}) {
  const probe = await listen(() => {});
  const port = probe.server.address().port;
  await new Promise((resolve) => probe.server.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lampac-mcp-cab-'));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), MCP_TOKEN: token, MCP_ENABLE_WRITES: 'false',
      COLLECTIONS_FILE: path.join(dir, 'collections.json'), LAMPAC_URL: '',
      GROQ_BASE: `${fake.base}/groq`, GEMINI_BASE: `${fake.base}/gemini`, TMDB_BASE: `${fake.base}/tmdb`, TMDB_API_KEY: 'k',
      CABINET_ADMIN_PASSWORD: '', CABINET_HOSTS: '', ...extraEnv,
    },
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  let cookie = '';
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(`${base}/cabinet/api${route}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const unlock = async () => {
    await call('POST', '/login', { username: 'admin', password: 'admin' });
    await call('POST', '/password', { current: 'admin', next: 'a-better-password' });
  };
  return { base, port, token, dir, call, unlock };
}

test('cabinet: default admin, password change, users, static page', async (t) => {
  const fake = await fakes(t);
  const { base, dir, call } = await launch(t, fake);

  assert.equal((await call('GET', '/rows')).status, 401);
  assert.equal((await call('POST', '/login', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await call('POST', '/login', { username: 'admin', password: 'admin' });
  assert.equal(login.status, 200);
  assert.equal(login.body.default_password, true);
  assert.equal((await stat(path.join(dir, 'users.json'))).mode & 0o777, 0o600);
  const locked = await call('GET', '/rows');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.must_change_password, true);
  assert.equal((await call('GET', '/config')).status, 200);

  assert.equal((await call('POST', '/password', { current: 'admin', next: 'short' })).status, 400);
  assert.equal((await call('POST', '/password', { current: 'admin', next: 'a-better-password' })).status, 200);
  assert.equal((await call('GET', '/me')).body.default_password, false);

  assert.equal((await call('POST', '/users', { username: 'guest', password: 'guest-password' })).status, 200);
  assert.deepEqual((await call('GET', '/users')).body.users.map((u) => u.username), ['admin', 'guest']);
  assert.equal((await call('DELETE', '/users/admin')).status, 400);
  assert.equal((await call('DELETE', '/users/guest')).status, 200);

  assert.equal((await call('POST', '/users', { username: 'x2', password: 'long-password' }, { Origin: 'https://evil.example' })).status, 403);

  const page = await fetch(`${base}/cabinet/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${base}/cabinet/..%2Fserver.mjs`)).status, 404);
});

test('cabinet: keys stay on the server, generation drops invented titles, rows saved with idea', async (t) => {
  const fake = await fakes(t);
  const { call, unlock } = await launch(t, fake);
  await unlock();

  const ai = await call('PUT', '/ai', { provider: 'groq', keys: { groq: 'secret-groq-key', gemini: 'secret-gemini-key' }, models: { groq: 'model-a', gemini: 'g-1' } });
  assert.deepEqual(ai.body.keys, { gemini: true, groq: true });
  assert.equal(JSON.stringify(ai.body).includes('secret-'), false);
  assert.equal(JSON.stringify((await call('GET', '/ai')).body).includes('secret-'), false);

  assert.deepEqual((await call('POST', '/ai/models', { provider: 'groq' })).body.models, ['model-a', 'model-b']);
  assert.deepEqual((await call('POST', '/ai/models', { provider: 'gemini' })).body.models, ['g-1']);

  for (const provider of ['groq', 'gemini']) {
    const gen = await call('POST', '/generate', { idea: 'cosy autumn films', kind: 'movies', count: 5, provider });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.deepEqual(gen.body.items.map((x) => [x.media_type, x.id, x.title]), [['movie', 11, 'Справжній фільм'], ['tv', 22, 'Справжній серіал']]);
    assert.deepEqual(gen.body.skipped, ['Invented Title']);
  }

  const gen = await call('POST', '/generate', { idea: 'cosy autumn films', kind: 'movies', count: 5 });
  const saved = await call('PUT', '/rows/movies-test', { title: 'Осінь', kind: 'movies', style: 'poster', idea: 'cosy autumn films', items: gen.body.items });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.rows[0].idea, 'cosy autumn films');
  assert.deepEqual(Object.keys(saved.body.rows[0].items[0]).sort(), ['id', 'media_type', 'original_title', 'poster_path', 'source', 'title']);
  const moved = await call('PUT', '/rows/movies-test', { title: 'Осінь 2' });
  assert.equal(moved.body.rows[0].title, 'Осінь 2');
  assert.equal(moved.body.rows[0].items.length, 2);
  assert.equal((await call('DELETE', '/rows/movies-test')).body.rows.length, 0);
});

test('cabinet: a new MCP token replaces the one from the environment', async (t) => {
  const fake = await fakes(t);
  const { base, token, unlock, call } = await launch(t, fake);
  const ping = (bearer) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal((await ping(token)).status, 200);
  await unlock();
  const issued = await call('POST', '/mcp-token', {});
  assert.match(issued.body.token, /^[0-9a-f]{64}$/);
  assert.equal((await ping(token)).status, 401);
  assert.equal((await ping(issued.body.token)).status, 200);
});

test('cabinet: CABINET_HOSTS rejects other Host headers; CABINET_ADMIN_PASSWORD replaces admin/admin', async (t) => {
  const fake = await fakes(t);
  const { port, call } = await launch(t, fake, { CABINET_HOSTS: 'cabinet.example', CABINET_ADMIN_PASSWORD: 'preset-password' });
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/cabinet/', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await get('evil.example'), 421);
  assert.equal(await get('cabinet.example'), 200);
  const login = (password) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/cabinet/api/login', method: 'POST',
      headers: { Host: 'cabinet.example', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify({ username: 'admin', password }));
  });
  assert.equal(await login('admin'), 401);
  assert.equal(await login('preset-password'), 200);
  assert.ok(call);
});

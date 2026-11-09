import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createTmdbProxy } from '../src/tmdb-proxy.mjs';

// a minimal server around the proxy, as server.mjs wires it
function sendJson(res, status, body, extra = {}) { res.writeHead(status, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(body)); }
function sendText(res, status, body, type, extra = {}) { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(body); }

async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('TMDB proxy adds the server key, keeps the query, caches, refuses other paths', async (t) => {
  const seen = [];
  const fake = await serve((req, res) => { seen.push(req.url); sendJson(res, 200, { ok: true, path: new URL(req.url, 'http://x').pathname }); });
  t.after(() => fake.server.close());
  const handle = createTmdbProxy({ base: fake.base, key: 'server-key' });
  const app = await serve((req, res) => handle(req, res, new URL(req.url, 'http://x'), sendJson, sendText));
  t.after(() => app.server.close());

  const r1 = await fetch(`${app.base}/api/tmdb/movie/603?language=uk-UA&api_key=client-key`);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r1.json(), { ok: true, path: '/movie/603' });
  assert.equal(seen.length, 1);
  const q = new URL(seen[0], 'http://x').searchParams;
  assert.equal(q.get('api_key'), 'server-key');      // the client's key is replaced
  assert.equal(q.get('language'), 'uk-UA');

  await fetch(`${app.base}/api/tmdb/movie/603?language=uk-UA`);
  assert.equal(seen.length, 1, 'second answer comes from the cache');

  assert.equal((await fetch(`${app.base}/api/tmdb/account`)).status, 404);
  assert.equal((await fetch(`${app.base}/api/tmdb/tv/1396/season/1`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/tmdb/movie/603`, { method: 'POST' })).status, 405);
});

test('TMDB proxy without a key says so', async (t) => {
  const handle = createTmdbProxy({ base: 'http://127.0.0.1:9', key: '' });
  const app = await serve((req, res) => handle(req, res, new URL(req.url, 'http://x'), sendJson, sendText));
  t.after(() => app.server.close());
  assert.equal((await fetch(`${app.base}/api/tmdb/genre/movie/list`)).status, 503);
});

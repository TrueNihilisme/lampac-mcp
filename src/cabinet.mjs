// Web cabinet: login, users, AI provider settings, MCP token, rows and row generation.
// Static page in /cabinet, JSON API in /cabinet/api/*. Keep it on a trusted network.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, PROVIDER_INFO, fillImages, generateRow, listModels } from './ai.mjs';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cabinet');
const SESSION_COOKIE = 'lmcp_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const USERNAME = /^[a-zA-Z0-9._-]{2,32}$/;
// Posters in the cabinet: through the Lampac TMDB proxy when LAMPAC_URL is set, otherwise straight from TMDB.
const IMG_BASE = (process.env.TMDB_IMG_BASE || (process.env.LAMPAC_URL ? `${process.env.LAMPAC_URL.replace(/\/+$/, '')}/tmdb/img/t/p/` : 'https://image.tmdb.org/t/p/'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createCabinet(ctx) {
  const DATA = path.dirname(ctx.collectionFile);
  const USERS_FILE = path.join(DATA, 'users.json');
  const SETTINGS_FILE = path.join(DATA, 'settings.json');
  const sessions = new Map();
  const attempts = new Map();
  let settingsCache = null;
  let lock = Promise.resolve();

  async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function writeJson(file, value) {
    const next = lock.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
    });
    lock = next.catch(() => {});
    await next;
  }

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  }

  function checkPassword(password, stored) {
    const [scheme, salt, hash] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  // First start: one user `admin` with CABINET_ADMIN_PASSWORD, or `admin` / `admin`. While the default
  // password is in place every API call except /me, /password and /logout is refused (see handle()).
  async function readUsers() {
    const users = await readJson(USERS_FILE, null);
    if (Array.isArray(users) && users.length) return users;
    const preset = process.env.CABINET_ADMIN_PASSWORD || '';
    const initial = [{ username: 'admin', password: hashPassword(preset || 'admin'), created_at: new Date().toISOString() }];
    if (!preset) initial[0].default_password = true;
    await writeJson(USERS_FILE, initial);
    return initial;
  }

  async function readSettings() {
    if (!settingsCache) settingsCache = await readJson(SETTINGS_FILE, {});
    return settingsCache;
  }

  async function saveSettings(settings) {
    await writeJson(SETTINGS_FILE, settings);
    settingsCache = settings;
  }

  // MCP bearer token: a token set in the cabinet (stored as SHA-256) replaces MCP_TOKEN from the environment.
  async function tokenMatches(supplied) {
    const settings = await readSettings();
    const expected = settings.mcp_token_sha256
      ? Buffer.from(settings.mcp_token_sha256, 'hex')
      : crypto.createHash('sha256').update(ctx.envToken).digest();
    const actual = crypto.createHash('sha256').update(String(supplied)).digest();
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function cookie(req, name) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
    return match ? decodeURIComponent(match[1]) : '';
  }

  function sessionUser(req) {
    const id = cookie(req, SESSION_COOKIE);
    const session = id && sessions.get(id);
    if (!session || session.expires < Date.now()) {
      if (session) sessions.delete(id);
      return null;
    }
    session.expires = Date.now() + SESSION_TTL;
    return session.username;
  }

  async function body(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
    }
    const text = await ctx.readBody(req);
    try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  // State-changing requests must come from the cabinet page itself.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function tooManyAttempts(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
    attempts.set(ip, list);
    return list.length >= LOGIN_MAX;
  }

  async function serveStatic(res, pathname) {
    const name = pathname === '/cabinet' || pathname === '/cabinet/' ? 'index.html' : pathname.slice('/cabinet/'.length);
    if (!/^[a-z0-9._-]+$/i.test(name)) return ctx.sendText(res, 404, 'Not Found');
    const type = TYPES[path.extname(name)];
    if (!type) return ctx.sendText(res, 404, 'Not Found');
    try {
      const data = await fs.readFile(path.join(STATIC, name));
      return ctx.sendText(res, 200, data, type, {
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
      });
    } catch {
      return ctx.sendText(res, 404, 'Not Found');
    }
  }

  function aiView(settings) {
    const ai = settings.ai || {};
    return {
      provider: ai.provider || '',
      models: ai.models || {},
      bases: ai.bases || {},
      keys: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(ai.keys?.[p])])),
      providers: PROVIDERS,
      info: Object.fromEntries(PROVIDERS.map((p) => [p, {
        label: PROVIDER_INFO[p].label, key_required: PROVIDER_INFO[p].key, editable_base: !PROVIDER_INFO[p].base,
        example: PROVIDER_INFO[p].example || '',
      }])),
    };
  }

  const CARD_FIELDS = ['id', 'media_type', 'title', 'original_title', 'poster_path', 'backdrop_path', 'vote_average'];
  const pickCard = (item) => Object.fromEntries(CARD_FIELDS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));

  async function api(req, res, route, user) {
    const json = (status, value) => ctx.sendJson(res, status, value);
    const method = req.method;

    if (route === '/me' && method === 'GET') {
      const me = (await readUsers()).find((u) => u.username === user);
      return json(200, { username: user, default_password: Boolean(me?.default_password) });
    }
    if (route === '/logout' && method === 'POST') {
      sessions.delete(cookie(req, SESSION_COOKIE));
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/cabinet; HttpOnly; SameSite=Strict; Max-Age=0`);
      return json(200, { ok: true });
    }
    if (route === '/password' && method === 'POST') {
      const { current, next } = await body(req);
      if (typeof next !== 'string' || next.length < 8) return json(400, { error: 'Новий пароль — щонайменше 8 символів.' });
      const users = await readUsers();
      const me = users.find((u) => u.username === user);
      if (!me || !checkPassword(current, me.password)) return json(403, { error: 'Поточний пароль невірний.' });
      me.password = hashPassword(next);
      delete me.default_password;
      await writeJson(USERS_FILE, users);
      return json(200, { ok: true });
    }
    if (route === '/users' && method === 'GET') {
      return json(200, { users: (await readUsers()).map((u) => ({ username: u.username, created_at: u.created_at })) });
    }
    if (route === '/users' && method === 'POST') {
      const { username, password } = await body(req);
      if (!USERNAME.test(username || '')) return json(400, { error: 'Логін: 2–32 символи, латиниця, цифри, . _ -' });
      if (typeof password !== 'string' || password.length < 8) return json(400, { error: 'Пароль — щонайменше 8 символів.' });
      const users = await readUsers();
      if (users.some((u) => u.username === username)) return json(409, { error: 'Такий користувач уже є.' });
      users.push({ username, password: hashPassword(password), created_at: new Date().toISOString() });
      await writeJson(USERS_FILE, users);
      return json(200, { ok: true });
    }
    const userRoute = /^\/users\/([^/]+)$/.exec(route);
    if (userRoute && method === 'DELETE') {
      const name = decodeURIComponent(userRoute[1]);
      if (name === user) return json(400, { error: 'Себе видалити не можна.' });
      const users = await readUsers();
      const left = users.filter((u) => u.username !== name);
      if (left.length === users.length) return json(404, { error: 'Нема такого користувача.' });
      await writeJson(USERS_FILE, left);
      for (const [id, s] of sessions) if (s.username === name) sessions.delete(id);
      return json(200, { ok: true });
    }

    if (route === '/ai' && method === 'GET') return json(200, aiView(await readSettings()));
    if (route === '/ai' && method === 'PUT') {
      const input = await body(req);
      const settings = structuredClone(await readSettings());
      const ai = settings.ai || (settings.ai = {});
      ai.keys = ai.keys || {};
      ai.models = ai.models || {};
      ai.bases = ai.bases || {};
      if (input.provider !== undefined) {
        if (!PROVIDERS.includes(input.provider)) return json(400, { error: 'Невідомий провайдер.' });
        ai.provider = input.provider;
      }
      for (const p of PROVIDERS) {
        if (typeof input.keys?.[p] === 'string') {
          const key = input.keys[p].trim();
          if (key.length > 300) return json(400, { error: 'Ключ задовгий.' });
          if (key) ai.keys[p] = key; else delete ai.keys[p];
        }
        if (typeof input.models?.[p] === 'string') ai.models[p] = input.models[p].trim().slice(0, 120);
        if (typeof input.bases?.[p] === 'string' && !PROVIDER_INFO[p].base) {
          const base = input.bases[p].trim();
          if (base && !/^https?:\/\/[^\s]{3,200}$/.test(base)) return json(400, { error: 'Адреса має починатися з http:// або https://' });
          if (base) ai.bases[p] = base.replace(/\/+$/, ''); else delete ai.bases[p];
        }
      }
      await saveSettings(settings);
      return json(200, aiView(settings));
    }
    if (route === '/ai/models' && method === 'POST') {
      const { provider } = await body(req);
      const settings = await readSettings();
      if (!PROVIDERS.includes(provider)) return json(400, { error: 'Невідомий провайдер.' });
      try { return json(200, { models: await listModels(provider, settings.ai?.keys?.[provider], settings.ai?.bases) }); } catch (error) {
        return json(502, { error: `Провайдер відповів: ${error.message}` });
      }
    }

    if (route === '/mcp-token' && method === 'POST') {
      const token = crypto.randomBytes(32).toString('hex');
      const settings = structuredClone(await readSettings());
      settings.mcp_token_sha256 = crypto.createHash('sha256').update(token).digest('hex');
      settings.mcp_token_changed_at = new Date().toISOString();
      await saveSettings(settings);
      return json(200, { token });
    }
    if (route === '/mcp' && method === 'GET') {
      const settings = await readSettings();
      return json(200, { path: '/mcp', token_changed_at: settings.mcp_token_changed_at || null });
    }

    if (route === '/rows' && method === 'GET') {
      const data = await ctx.readRows();
      if (await fillImages(data.rows)) await ctx.saveRows(data);
      return json(200, data);
    }
    if (route === '/generate' && method === 'POST') {
      const { idea, kind, count, provider: wanted } = await body(req);
      const settings = await readSettings();
      const provider = wanted || settings.ai?.provider;
      try {
        return json(200, await generateRow({
          provider, key: settings.ai?.keys?.[provider], model: settings.ai?.models?.[provider], idea, kind, count, bases: settings.ai?.bases,
        }));
      } catch (error) {
        return json(502, { error: error.message });
      }
    }
    const rowRoute = /^\/rows\/([a-z0-9-]+)$/.exec(route);
    if (rowRoute && method === 'PUT') {
      const input = await body(req);
      const id = rowRoute[1];
      const data = await ctx.readRows();
      const current = data.rows.find((r) => r.id === id);
      // stored cards carry `source`, which the row validator does not accept back; keep only card fields
      const items = (Array.isArray(input.items) ? input.items : current?.items)?.map(pickCard);
      if (!items) return json(400, { error: 'Нема карток для нового ряду.' });
      try {
        await ctx.setRow({
          id,
          title: input.title ?? current?.title,
          kind: input.kind ?? current?.kind,
          style: input.style ?? current?.style,
          idea: input.idea ?? current?.idea,
          position: input.position,
          items,
        });
      } catch (error) {
        return json(400, { error: error.message });
      }
      return json(200, await ctx.readRows());
    }
    if (rowRoute && method === 'DELETE') {
      try { await ctx.deleteRow(rowRoute[1]); } catch (error) { return json(404, { error: error.message }); }
      return json(200, await ctx.readRows());
    }
    if (route === '/cub-log' && method === 'GET') return json(200, { requests: ctx.cubLog });
    if (route === '/config' && method === 'GET') return json(200, { img_base: IMG_BASE, kinds: ctx.kinds, styles: ctx.styles });

    return json(404, { error: 'Not Found' });
  }

  // Optional allowlist of Host headers (CABINET_HOSTS=host:port,name): blunts DNS rebinding.
  const HOSTS = (process.env.CABINET_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const UNLOCKED = new Set(['/me', '/password', '/logout', '/config']);

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (HOSTS.length && !HOSTS.includes(String(req.headers.host || '').toLowerCase())) return ctx.sendText(res, 421, 'Misdirected Request');
    if (!pathname.startsWith('/cabinet/api/')) {
      if (req.method !== 'GET') return ctx.sendText(res, 405, 'Method Not Allowed');
      return serveStatic(res, pathname);
    }
    const route = pathname.slice('/cabinet/api'.length);
    if (req.method !== 'GET' && !sameOrigin(req)) return ctx.sendJson(res, 403, { error: 'Cross-origin request.' });

    if (route === '/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (tooManyAttempts(ip)) return ctx.sendJson(res, 429, { error: 'Забагато спроб. Спробуйте за 15 хвилин.' });
      const { username, password } = await body(req);
      const me = (await readUsers()).find((u) => u.username === username);
      if (!me || !checkPassword(password, me.password)) {
        attempts.get(ip).push(Date.now());
        return ctx.sendJson(res, 401, { error: 'Невірний логін або пароль.' });
      }
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, { username: me.username, expires: Date.now() + SESSION_TTL });
      return ctx.sendJson(res, 200, { username: me.username, default_password: Boolean(me.default_password) }, {
        'Set-Cookie': `${SESSION_COOKIE}=${id}; Path=/cabinet; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
      });
    }
    const user = sessionUser(req);
    if (!user) return ctx.sendJson(res, 401, { error: 'Потрібно увійти.' });
    if (!UNLOCKED.has(route) && (await readUsers()).find((u) => u.username === user)?.default_password) {
      return ctx.sendJson(res, 403, { error: 'Спершу змініть пароль за замовчуванням.', must_change_password: true });
    }
    return api(req, res, route, user);
  }

  return { handle, tokenMatches, readUsers };
}

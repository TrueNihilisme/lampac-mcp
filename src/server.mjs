import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2025-11-25';
const COLLECTION_FILE = path.resolve(process.env.COLLECTIONS_FILE || path.join(ROOT, 'data', 'collections.json'));
const TOKEN = process.env.MCP_TOKEN || '';
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean));
const MAX_BODY = 1024 * 1024;
const WRITE_ENABLED = process.env.MCP_ENABLE_WRITES === 'true';

if (TOKEN.length < 32) {
  console.error('MCP_TOKEN must contain at least 32 characters.');
  process.exit(1);
}

let dataLock = Promise.resolve();

async function readCollection() {
  try {
    const parsed = JSON.parse(await fs.readFile(COLLECTION_FILE, 'utf8'));
    if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.items)) return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { title: 'AI picks', items: [] };
}

async function saveCollection(collection) {
  const next = dataLock.then(async () => {
    await fs.mkdir(path.dirname(COLLECTION_FILE), { recursive: true });
    const temp = `${COLLECTION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(collection, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, COLLECTION_FILE);
  });
  dataLock = next.catch(() => {});
  await next;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const bytes = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(bytes);
}

function tokenMatches(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = crypto.createHash('sha256').update(match[1]).digest();
  const expected = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || ORIGINS.has(origin);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const tools = [
  {
    name: 'get_ai_collection',
    description: 'Read the current AI-managed carousel collection shown by the Lampa plugin.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'replace_ai_collection',
    description: 'Replace the AI carousel title and all its TMDB cards. Requires writes enabled by the operator and an explicit approval phrase. Use only with an MCP client configured to ask the human before this tool runs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 100 },
        items: {
          type: 'array', maxItems: 100,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'integer', minimum: 1 },
              media_type: { type: 'string', enum: ['movie', 'tv'] },
              title: { type: 'string', minLength: 1, maxLength: 300 },
              original_title: { type: 'string', maxLength: 300 },
              poster_path: { type: 'string', maxLength: 500 },
              backdrop_path: { type: 'string', maxLength: 500 },
              release_date: { type: 'string', maxLength: 20 },
              first_air_date: { type: 'string', maxLength: 20 },
              overview: { type: 'string', maxLength: 2000 },
              vote_average: { type: 'number', minimum: 0, maximum: 10 },
            },
            required: ['id', 'media_type', 'title'],
          },
        },
        approval_phrase: { type: 'string', const: 'I have reviewed and approve replacing the AI collection.' },
      },
      required: ['title', 'items', 'approval_phrase'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'inspect_title_sources',
    description: 'Read the current list of Lampac sources for one TMDB title through /lite/events. This is a snapshot for one title; it does not establish a root cause or repair a source.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'integer', minimum: 1 },
        media_type: { type: 'string', enum: ['movie', 'tv'] },
        title: { type: 'string', minLength: 1, maxLength: 300 },
        original_title: { type: 'string', maxLength: 300 },
        original_language: { type: 'string', maxLength: 20 },
        year: { type: 'integer', minimum: 1870, maximum: 2200 },
        imdb_id: { type: 'string', maxLength: 20 },
        is_anime: { type: 'boolean' },
      },
      required: ['id', 'media_type', 'title'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'get_tvctl_log',
    description: 'Read the latest reports from the optional EX.TvCtl module. Requires LAMPAC_ROOT_PASSWORD; does not send commands to a device.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { last: { type: 'integer', minimum: 1, maximum: 200 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function resultText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

async function diagnoseTitle(args) {
  const base = process.env.LAMPAC_URL;
  if (!base) throw new Error('LAMPAC_URL is not configured.');
  const url = new URL('/lite/events', base);
  const params = {
    source: 'tmdb',
    id: String(args.id),
    title: args.title,
    serial: args.media_type === 'tv' ? '1' : '0',
  };
  if (args.original_title) params.original_title = args.original_title;
  if (args.original_language) params.original_language = args.original_language;
  if (args.year) params.year = String(args.year);
  if (args.imdb_id) params.imdb_id = args.imdb_id;
  if (args.is_anime) params.isanime = 'true';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Lampac returned HTTP ${response.status}.`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Lampac returned an unexpected response shape.');
    return {
      title: args.title,
      tmdb_id: args.id,
      media_type: args.media_type,
      checked_at: new Date().toISOString(),
      sources: rows.map((row) => ({ name: String(row.name || ''), available: Boolean(row.show) })),
      note: 'Availability is the current response for this title only; missing sources do not prove a balancer is down.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getTvctlLog(last = 50) {
  const base = process.env.LAMPAC_URL;
  const password = process.env.LAMPAC_ROOT_PASSWORD || '';
  if (!base) throw new Error('LAMPAC_URL is not configured.');
  if (!password) throw new Error('LAMPAC_ROOT_PASSWORD is not configured.');
  if (/[\r\n;]/.test(password)) throw new Error('LAMPAC_ROOT_PASSWORD contains unsupported cookie characters.');
  const count = Number.isInteger(last) ? Math.min(200, Math.max(1, last)) : 50;
  const url = new URL('/tvctl/log', base);
  url.searchParams.set('last', String(count));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain', Cookie: `accspasswd=${password}` },
    });
    if (!response.ok) throw new Error(`EX.TvCtl returned HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > 200000) throw new Error('EX.TvCtl log response is too large.');
    return { last: count, lines: text.split(/\r?\n/).filter(Boolean) };
  } finally {
    clearTimeout(timer);
  }
}

async function callTool(name, args) {
  if (name === 'get_ai_collection') return resultText(await readCollection());
  if (name === 'replace_ai_collection') {
    if (!WRITE_ENABLED) throw new Error('Writes are disabled. Set MCP_ENABLE_WRITES=true after configuring human approval in the MCP client.');
    if (args.approval_phrase !== 'I have reviewed and approve replacing the AI collection.') throw new Error('The required approval phrase is missing.');
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100 || !Array.isArray(args.items) || args.items.length > 100) {
      throw new Error('Provide a title and an array of at most 100 cards.');
    }
    if (Object.keys(args).some((key) => !['title', 'items', 'approval_phrase'].includes(key))) throw new Error('Unexpected collection field.');
    const ids = new Set();
    const items = args.items.map((item) => {
      if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || !['movie', 'tv'].includes(item.media_type) ||
          typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300) {
        throw new Error('Each card needs a positive integer id, media_type movie/tv, and non-empty title.');
      }
      const limits = { original_title: 300, poster_path: 500, backdrop_path: 500, release_date: 20, first_air_date: 20, overview: 2000 };
      if (Object.keys(item).some((key) => !['id', 'media_type', 'title', ...Object.keys(limits), 'vote_average'].includes(key))) {
        throw new Error('Card contains an unsupported field.');
      }
      for (const [field, limit] of Object.entries(limits)) {
        if (item[field] !== undefined && (typeof item[field] !== 'string' || item[field].length > limit)) {
          throw new Error(`Invalid card field: ${field}.`);
        }
      }
      if (item.vote_average !== undefined && (typeof item.vote_average !== 'number' || item.vote_average < 0 || item.vote_average > 10)) {
        throw new Error('vote_average must be between 0 and 10.');
      }
      const key = `${item.media_type}:${item.id}`;
      if (ids.has(key)) throw new Error(`Duplicate card: ${key}.`);
      ids.add(key);
      const clean = { id: item.id, media_type: item.media_type, title: item.title.trim(), source: 'tmdb' };
      for (const field of Object.keys(limits)) if (item[field] !== undefined) clean[field] = item[field];
      if (item.vote_average !== undefined) clean.vote_average = item.vote_average;
      return clean;
    });
    const collection = { title: args.title.trim(), updated_at: new Date().toISOString(), items };
    if (!collection.title) throw new Error('Collection title cannot be empty.');
    await saveCollection(collection);
    return resultText({ ok: true, title: collection.title, items: items.length });
  }
  if (name === 'inspect_title_sources') return resultText(await diagnoseTitle(args));
  if (name === 'get_tvctl_log') {
    const last = args.last === undefined ? 50 : args.last;
    if (!Number.isInteger(last) || last < 1 || last > 200) throw new Error('last must be an integer from 1 to 200.');
    return resultText(await getTvctlLog(last));
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

async function handleRpc(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'Invalid Request');
  }
  const id = Object.hasOwn(message, 'id') ? message.id : undefined;
  const notification = id === undefined;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null;
  if (notification) return null;
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lampac-mcp', version: '0.1.0-alpha.1' },
        instructions: 'Read tools are available directly. The collection replacement tool is a write operation; use only when the host has obtained human approval.',
      },
    };
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
  if (message.method === 'tools/call') {
    try {
      const { name, arguments: args = {} } = message.params || {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, -32602, 'Invalid tool arguments.');
      }
      return { jsonrpc: '2.0', id, result: await callTool(name, args) };
    } catch (error) {
      if (error.rpcCode) return rpcError(id, error.rpcCode, error.message);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message || 'Tool failed.' }], isError: true } };
    }
  }
  return rpcError(id, -32601, `Method not found: ${message.method}`);
}

async function handleMcp(req, res) {
  if (!originAllowed(req)) return sendJson(res, 403, rpcError(undefined, -32000, 'Origin is not allowed.'));
  if (!tokenMatches(req)) return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  if (req.method === 'GET') return sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
  if (req.method !== 'POST') return sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'POST, GET' });
  const accept = req.headers.accept || '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return sendText(res, 406, 'Accept must include application/json and text/event-stream.');
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return sendText(res, 415, 'Content-Type must be application/json.');
  }
  const version = req.headers['mcp-protocol-version'];
  if (version && version !== PROTOCOL_VERSION) return sendText(res, 400, `Unsupported MCP-Protocol-Version: ${version}`);
  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, error.status || 400, rpcError(undefined, -32700, error.status ? error.message : 'Parse error'));
  }
  const response = await handleRpc(message);
  if (response === null) {
    res.writeHead(202, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, 200, response);
}

// Local stand-in for CUB (Lampa's cloud service). Lampac's CubProxy forwards Lampa's
// /cub/red/<path> requests to `${cub.scheme}://${cub.domain}/<path>` from init.conf; pointing
// cub.domain at <this server>/cub keeps every such request on the local network.
// Lampa treats an error from these endpoints as "nothing there" (no comments block,
// no reactions, no CUB collections), so 404 is the answer for almost everything.
const CUB_PREFIX = '/cub/';
const CUB_LOG_MAX = 200;
const cubLog = [];

async function handleCub(req, res, url) {
  const route = url.pathname.slice(CUB_PREFIX.length - 1);
  // Path only: query strings carry device ids and tokens.
  cubLog.push({ time: new Date().toISOString(), method: req.method, path: route });
  if (cubLog.length > CUB_LOG_MAX) cubLog.shift();

  if (req.method === 'POST') {
    // logs upload, reactions: accept and drop
    req.resume();
    await once(req, 'end');
    return sendJson(res, 200, { secuses: true });
  }
  // Lampa loads these as <script>; an empty script avoids load errors on the device.
  if (route.startsWith('/plugin/')) {
    return sendText(res, 200, '/* local CUB stand-in: plugin not provided */', 'application/javascript; charset=utf-8');
  }
  return sendJson(res, 404, { secuses: false, error: 'Not provided by the local CUB stand-in' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (url.pathname === MCP_PATH) return await handleMcp(req, res);
    if (url.pathname.startsWith(CUB_PREFIX)) return await handleCub(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/cub-log') return sendJson(res, 200, { requests: cubLog });
    if (req.method === 'GET' && url.pathname === '/api/collection') {
      return sendJson(res, 200, await readCollection(), { 'Access-Control-Allow-Origin': '*' });
    }
    if (req.method === 'GET' && url.pathname === '/plugin.js') {
      const script = await fs.readFile(path.join(ROOT, 'plugin', 'lampac-mcp.js'));
      return sendText(res, 200, script, 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, name: 'lampac-mcp' });
    return sendText(res, 404, 'Not Found');
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.destroy();
    console.error(error.message || 'request failed');
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '8787', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a valid TCP port.');
  process.exit(1);
}
server.listen(port, host, () => console.log(`lampac-mcp listening on ${host}:${port}`));

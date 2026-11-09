// GET /api/tmdb/<path>?<query> → TMDB with this server's key.
//
// For TV front-ends (Glint): the key never leaves the server and nothing has to be typed on a TV.
// Read-only and limited to the paths a front-end needs (lists, a title, a season, a person, search);
// a key sent by the client is dropped and replaced with the server's. Good answers are kept 30 minutes.

const ALLOWED = [
  /^\/genre\/(movie|tv)\/list$/,
  /^\/trending\/(all|movie|tv|person)\/(day|week)$/,
  /^\/discover\/(movie|tv)$/,
  /^\/(movie|tv)\/\d+$/,
  /^\/(movie|tv)\/\d+\/(credits|external_ids|images|videos|recommendations|similar)$/,
  /^\/tv\/\d+\/season\/\d+$/,
  /^\/person\/\d+(\/(movie_credits|tv_credits|combined_credits))?$/,
  /^\/search\/(movie|tv|multi|person)$/,
];

export const TMDB_PREFIX = '/api/tmdb';

export function createTmdbProxy({ base, key, fetchImpl = fetch, ttlMs = 30 * 60 * 1000, max = 500 }) {
  const cache = new Map();   // insertion order = age; the oldest goes first when full

  return async function handle(req, res, url, sendJson, sendText) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' }, cors);
    if (!key) return sendJson(res, 503, { error: 'TMDB key is not configured on this server' }, cors);
    const route = url.pathname.slice(TMDB_PREFIX.length);
    if (!ALLOWED.some((r) => r.test(route))) return sendJson(res, 404, { error: 'This TMDB path is not proxied' }, cors);

    const params = new URLSearchParams(url.search);
    params.delete('api_key');
    params.sort();
    const id = route + '?' + params.toString();
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ttlMs) return sendText(res, 200, hit.body, 'application/json; charset=utf-8', cors);

    params.set('api_key', key);
    let response;
    try {
      response = await fetchImpl(base.replace(/\/+$/, '') + route + '?' + params.toString(), { signal: AbortSignal.timeout(15000) });
    } catch {
      return sendJson(res, 502, { error: 'TMDB did not answer' }, cors);
    }
    const body = await response.text();
    if (response.ok) {
      cache.delete(id);
      cache.set(id, { at: Date.now(), body });
      if (cache.size > max) cache.delete(cache.keys().next().value);
    }
    return sendText(res, response.status, body, 'application/json; charset=utf-8', cors);
  };
}

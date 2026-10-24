// Row generation: an idea in plain words -> an LLM proposes titles -> each title is looked up in TMDB.
// Only titles TMDB knows (with a poster) end up in a row, so invented titles are dropped.

const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1';
const TMDB_BASE = (process.env.TMDB_BASE || (process.env.LAMPAC_URL ? `${process.env.LAMPAC_URL.replace(/\/+$/, '')}/tmdb/api/3` : 'https://api.themoviedb.org/3')).replace(/\/+$/, '');
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_LANGUAGE = process.env.TMDB_LANGUAGE || 'uk-UA';
const TIMEOUT = 45000;

export const PROVIDERS = ['gemini', 'groq'];

const KIND_HINT = {
  movies: 'live-action feature films (no animation)',
  series: 'live-action TV series (no animation)',
  cartoons: 'animated films and animated series that are not Japanese anime',
  anime: 'Japanese anime series and anime films',
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const message = body?.error?.message || body?.status_message || text.slice(0, 200) || response.statusText;
    throw Object.assign(new Error(`HTTP ${response.status}: ${message}`), { status: response.status });
  }
  return body;
}

export async function listModels(provider, key) {
  if (!key) throw new Error('API key is not set.');
  if (provider === 'groq') {
    const body = await fetchJson(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    return (body?.data || []).filter((m) => m.active !== false).map((m) => m.id).sort();
  }
  if (provider === 'gemini') {
    const body = await fetchJson(`${GEMINI_BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`);
    return (body?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, '')).sort();
  }
  throw new Error(`Unknown provider: ${provider}`);
}

function prompt(idea, kind, count) {
  return [
    'You curate rows for the main screen of a home media centre.',
    `Request from the owner (any language): ${JSON.stringify(idea)}`,
    `Row type: ${KIND_HINT[kind] || 'films and series'}.`,
    `Suggest ${count} real titles that exist in TMDB and fit the request. No duplicates, no titles you are unsure exist.`,
    'Answer with JSON only: {"items":[{"original_title":"title in the original language or English","year":2020,"type":"movie"|"tv"}]}',
  ].join('\n');
}

function parseItems(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    const match = /\{[\s\S]*\}/.exec(text || '');
    if (!match) throw new Error('The model did not return JSON.');
    data = JSON.parse(match[0]);
  }
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) throw new Error('The model returned JSON without an items list.');
  return items.filter((x) => x && typeof x.original_title === 'string' && x.original_title.trim());
}

async function askModel(provider, key, model, text) {
  if (!key) throw new Error('API key is not set.');
  if (!model) throw new Error('Model is not selected.');
  if (provider === 'groq') {
    const request = (jsonMode) => fetchJson(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        temperature: 0.7,
      }),
    });
    let body;
    try { body = await request(true); } catch (error) {
      // JSON mode sometimes rejects the model's own output ("Failed to validate JSON"); the prompt
      // asks for JSON anyway, so one retry without it usually works.
      if (error.status !== 400 || !/json/i.test(error.message)) throw error;
      body = await request(false);
    }
    return body?.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    const body = await fetchJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
      }),
    });
    return (body?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// Japanese kana, CJK ideographs, Hangul: a title in these scripts means TMDB has no Ukrainian translation.
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

const words = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

// TMDB search returns something for almost any query; keep a result only when its original or
// localized title shares most words with the proposed one.
function sameTitle(proposed, result) {
  const want = words(proposed);
  if (!want.length) return false;
  return [result.original_title, result.original_name, result.title, result.name].some((candidate) => {
    const have = new Set(words(candidate));
    if (!have.size) return false;
    const common = want.filter((w) => have.has(w)).length;
    return common / Math.max(want.length, have.size) >= 0.6;
  });
}

// Lampa shows the localized title; a foreign title TMDB has not translated is no use on the main screen.
function translated(result) {
  const title = result.title || result.name || '';
  const original = result.original_title || result.original_name || '';
  if (!title || CJK.test(title)) return false;
  return ['en', 'uk'].includes(result.original_language) || title !== original;
}

async function tmdbSearch(type, title, year) {
  const params = new URLSearchParams({ api_key: TMDB_API_KEY, language: TMDB_LANGUAGE, query: title });
  if (year) params.set(type === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year));
  const body = await fetchJson(`${TMDB_BASE}/search/${type}?${params}`);
  return body?.results || [];
}

// One proposed title -> one TMDB card, or null. Tries the proposed type first, then the other one,
// and without the year when the model got it slightly wrong.
async function resolve(item) {
  const types = item.type === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
  const year = Number.isInteger(item.year) ? item.year : Number.parseInt(item.year, 10) || null;
  for (const type of types) {
    for (const y of year ? [year, null] : [null]) {
      // A search with the year is already filtered by TMDB, and it also finds titles the model wrote
      // in another script (Pamfir / Памфір). Without the year, the title has to match and the year
      // may differ by one at most, or a namesake from another decade slips in.
      const found = (await tmdbSearch(type, item.original_title.trim(), y)).find((r) => {
        if (!r.poster_path) return false;
        if (y) return true;
        const ry = Number.parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10);
        return sameTitle(item.original_title, r) && (!year || (ry && Math.abs(ry - year) <= 1));
      });
      if (!found) continue;
      if (!translated(found)) return null;
      const title = found.title || found.name || '';
      return {
        id: found.id,
        media_type: type,
        title,
        original_title: found.original_title || found.original_name || '',
        poster_path: found.poster_path,
        backdrop_path: found.backdrop_path || undefined,
        year: (found.release_date || found.first_air_date || '').slice(0, 4),
        vote_average: typeof found.vote_average === 'number' ? found.vote_average : undefined,
      };
    }
  }
  return null;
}

export async function generateRow({ provider, key, model, idea, kind, count }) {
  if (!PROVIDERS.includes(provider)) throw new Error('Choose a provider.');
  if (typeof idea !== 'string' || !idea.trim() || idea.length > 1000) throw new Error('Describe the idea in up to 1000 characters.');
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured on the server.');
  const want = Math.min(Math.max(Number.parseInt(count, 10) || 15, 5), 30);
  // ask for a few more: some proposals are not found in TMDB
  const proposed = parseItems(await askModel(provider, key, model, prompt(idea.trim(), kind, Math.ceil(want * 1.4))));
  const items = [];
  const skipped = [];
  const seen = new Set();
  for (const p of proposed) {
    if (items.length >= want) break;
    let card = null;
    try { card = await resolve(p); } catch (error) { skipped.push(`${p.original_title}: ${error.message}`); continue; }
    if (!card) { skipped.push(p.original_title); continue; }
    const k = `${card.media_type}:${card.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(card);
  }
  return { items, skipped, proposed: proposed.length };
}

// Cards written without images (e.g. through MCP with only id and title) get poster and backdrop
// from TMDB once; returns true when something changed. Without TMDB_API_KEY it does nothing.
export async function fillImages(rows, limit = 40) {
  if (!TMDB_API_KEY) return false;
  const missing = [];
  for (const row of rows) for (const item of row.items || []) if (!item.poster_path) missing.push(item);
  let changed = false;
  for (const item of missing.slice(0, limit)) {
    try {
      const params = new URLSearchParams({ api_key: TMDB_API_KEY, language: TMDB_LANGUAGE });
      const found = await fetchJson(`${TMDB_BASE}/${item.media_type === 'tv' ? 'tv' : 'movie'}/${item.id}?${params}`);
      if (found?.poster_path) { item.poster_path = found.poster_path; changed = true; }
      if (found?.backdrop_path && !item.backdrop_path) { item.backdrop_path = found.backdrop_path; changed = true; }
    } catch { /* leave the card as it is */ }
  }
  return changed;
}

'use strict';

const KIND = { movies: 'Фільми', series: 'Серіали', cartoons: 'Мультфільми', anime: 'Аніме' };
const STYLE = { poster: 'вертикальні', wide: 'широкі' };
const providerLabel = (id) => (state.ai && state.ai.info[id] ? state.ai.info[id].label : id);

const state = { me: null, config: { img_base: 'https://image.tmdb.org/t/p/' }, rows: [], ai: null, view: 'home', preview: null, aiTab: null, edit: null, regen: {} };
const $ = (id) => document.getElementById(id);
const main = () => $('main');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/cabinet/api${path}`, options);
  let data = {};
  try { data = await response.json(); } catch { /* empty */ }
  if (response.status === 401 && path !== '/login') { showLogin(); throw new Error(data.error || 'Потрібно увійти.'); }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function img(path, size) {
  return path ? `${state.config.img_base}${size}${path}` : '';
}

function copy(text, button) {
  const done = () => { if (button) { const old = button.textContent; button.textContent = 'Скопійовано'; setTimeout(() => { button.textContent = old; }, 1500); } };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done);
  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  done();
}

function message(el, text, ok) {
  if (!el) return;
  el.className = `msg ${ok ? 'ok' : 'bad'}`;
  el.textContent = text;
}

/* ---------- login ---------- */

function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('lu').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('POST', '/login', { username: $('lu').value.trim(), password: $('lp').value });
    $('lp').value = '';
    await start();
  } catch (error) {
    message($('login-msg'), error.message, false);
  }
});

/* ---------- shell ---------- */

async function start() {
  state.me = await api('GET', '/me');
  state.config = await api('GET', '/config');
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('avatar').textContent = state.me.username.slice(0, 1);
  $('avatar').title = state.me.username;
  if (state.me.default_password) return viewFirstPassword();
  await refresh();
  const view = location.hash.slice(1);
  show(['home', 'rows', 'idea', 'ai', 'mcp', 'users', 'cub'].includes(view) ? view : 'home');
}

async function refresh() {
  const [rows, ai] = await Promise.all([api('GET', '/rows'), api('GET', '/ai')]);
  state.rows = rows.rows || [];
  state.ai = ai;
  $('nav-rows').textContent = state.rows.length || '';
  const ready = aiReady();
  const status = $('status');
  status.className = `st hide-s ${ready ? '' : 'w'}`;
  status.querySelector('span').textContent = ready ? `${providerLabel(ai.provider)} готовий` : 'ШІ не налаштовано';
}

function aiReady() {
  const ai = state.ai;
  if (!ai || !ai.provider || !ai.models[ai.provider]) return false;
  const info = ai.info[ai.provider];
  if (info.key_required && !ai.keys[ai.provider]) return false;
  return !info.editable_base || Boolean(ai.bases[ai.provider]);
}

function tick() {
  $('clock').textContent = new Date().toLocaleString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 30000);
tick();

function show(view) {
  state.view = view;
  location.hash = view;
  document.querySelectorAll('#nav .ni').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  const render = { home: viewHome, rows: viewRows, idea: viewIdea, ai: viewAi, mcp: viewMcp, users: viewUsers, cub: viewCub }[view];
  render();
}

window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (view !== state.view && !$('app').classList.contains('hidden') && !(state.me && state.me.default_password)
      && ['home', 'rows', 'idea', 'ai', 'mcp', 'users', 'cub'].includes(view)) show(view);
});

$('nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) show(button.dataset.view);
});

/* ---------- pieces ---------- */

function hero(title, subtitle, chips) {
  const bg = document.getElementById('hero-bg').innerHTML;
  return `<div class="hero">${bg}<h1>${title}</h1><div class="d">${esc(subtitle)}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}</div>`;
}

function defaultPasswordBanner() {
  if (!state.me.default_password) return '';
  return `<div class="banner">⚠ Ви входите з паролем за замовчуванням. <button class="btn sm pri" data-act="goto" data-to="users">Змінити пароль</button></div>`;
}

function rowLine(row, index) {
  const count = (row.items || []).length;
  return `<div class="row">
    <div class="ico">${index + 1}</div>
    <div><b>${esc(row.title)}</b><small>${esc(KIND[row.kind] || row.kind)} · ${count} карток${row.idea ? ' · є ідея' : ''}</small></div>
    <div class="end"><span class="tag ${row.style === 'wide' ? 'wide' : ''}">${esc(STYLE[row.style] || row.style)}</span></div>
  </div>`;
}

function strip(row) {
  const wide = row.style === 'wide';
  const pics = (row.items || []).slice(0, 12).map((it) => {
    const src = wide ? img(it.backdrop_path || it.poster_path, 'w300') : img(it.poster_path, 'w185');
    return src ? `<img loading="lazy" src="${esc(src)}" alt="${esc(it.title)}" title="${esc(it.title)}">` : '';
  }).join('');
  return `<div class="strip ${wide ? 'wide' : ''}">${pics || '<span class="mut">Постерів ще нема: Lampa підтягне їх сама.</span>'}</div>`;
}

function posters(items, removable) {
  return `<div class="posters">${items.map((it, i) => `
    <div class="pc ${it.off ? 'off' : ''}" ${removable ? `data-act="toggle-card" data-i="${i}"` : ''}>
      ${it.poster_path ? `<img loading="lazy" src="${esc(img(it.poster_path, 'w185'))}" alt="">` : ''}
      ${removable ? `<span class="x">${it.off ? '+' : '×'}</span>` : ''}
      <div class="t">${esc(it.title)}<small>${esc(it.year || '')} · ${it.media_type === 'tv' ? 'серіал' : 'фільм'}</small></div>
    </div>`).join('')}</div>`;
}

function options(map, selected) {
  return Object.entries(map).map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

/* ---------- views ---------- */

function viewHome() {
  const cards = state.rows.reduce((n, r) => n + (r.items || []).length, 0);
  const ai = state.ai;
  const chips = [
    `<div><i></i>${state.rows.length} рядів · ${cards} карток</div>`,
    `<div><i class="${aiReady() ? '' : 'w'}"></i>${aiReady() ? `${esc(providerLabel(ai.provider))}: ${esc(ai.models[ai.provider])}` : 'ШІ не налаштовано'}</div>`,
  ].join('');
  const date = new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  main().innerHTML = `
    ${hero(`<span>${esc(state.me.username)}, привіт!</span>`, `Сьогодні ${date}`, chips)}
    ${defaultPasswordBanner()}
    <div class="grid">
      <div class="blk c7">
        <div class="bh"><span class="bi">▤</span><b>Ряди на головній</b><div class="r"><button class="lnk" data-act="goto" data-to="rows">Усі ряди</button></div></div>
        ${state.rows.length ? state.rows.map(rowLine).join('') : '<div class="empty">Рядів ще нема. Почніть з нової ідеї.</div>'}
      </div>
      <div class="blk c5">
        <div class="bh"><span class="bi">⚡</span><b>Швидкі дії</b></div>
        <div class="qa">
          <button data-act="goto" data-to="idea"><span class="q">✦</span>Нова ідея для ряду</button>
          <button data-act="goto" data-to="rows"><span class="q">▤</span>Порядок рядів</button>
          <button data-act="goto" data-to="ai"><span class="q">◈</span>Ключі Gemini / Groq</button>
          <button data-act="goto" data-to="mcp"><span class="q">⌘</span>Токен MCP</button>
          <button data-act="goto" data-to="users"><span class="q">◉</span>Пароль і користувачі</button>
          <button data-act="goto" data-to="cub"><span class="q">⛨</span>Журнал CUB</button>
        </div>
      </div>
    </div>`;
}

function viewRows() {
  const rows = state.rows;
  main().innerHTML = `
    ${hero('<span>Ряди</span>', 'Порядок тут — порядок на головній Lampa. Ряди Lampa («Продовжити перегляд», виходи серій) — унизу.')}
    ${rows.length ? '' : '<div class="blk"><div class="empty">Рядів ще нема.</div><button class="btn pri" data-act="goto" data-to="idea">Нова ідея</button></div>'}
    ${rows.map((row, i) => {
      const editing = state.edit === row.id;
      const regen = state.regen[row.id];
      return `<div class="blk" data-row="${esc(row.id)}">
        <div class="bh">
          <span class="bi">${i + 1}</span><b>${esc(row.title)}</b>
          <span class="tag">${esc(KIND[row.kind] || row.kind)}</span><span class="tag ${row.style === 'wide' ? 'wide' : ''}">${esc(STYLE[row.style])}</span>
          <div class="r">
            <button class="btn sm" data-act="move" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Вище">↑</button>
            <button class="btn sm" data-act="move" data-dir="1" ${i === rows.length - 1 ? 'disabled' : ''} title="Нижче">↓</button>
            <button class="btn sm" data-act="edit">Змінити</button>
            <button class="btn sm" data-act="regen" ${row.idea ? '' : 'disabled title="Ряд без ідеї"'}>Оновити з ідеї</button>
            <button class="btn sm bad" data-act="delete">Видалити</button>
          </div>
        </div>
        ${row.idea ? `<div class="mut">Ідея: ${esc(row.idea)}</div>` : ''}
        ${strip(row)}
        ${editing ? `<div class="fl mt">
            <div><label class="f">Назва<input class="inp" data-f="title" value="${esc(row.title)}" maxlength="100"></label></div>
            <div><label class="f">Тип<select class="inp" data-f="kind">${options(KIND, row.kind)}</select></label></div>
            <div><label class="f">Картки<select class="inp" data-f="style">${options(STYLE, row.style)}</select></label></div>
          </div>
          <label class="f">Ідея (для «Оновити з ідеї»)<textarea class="inp" data-f="idea" maxlength="1000">${esc(row.idea || '')}</textarea></label>
          <button class="btn pri" data-act="save-edit">Зберегти</button> <button class="btn" data-act="cancel-edit">Скасувати</button>
          <div class="msg" data-msg></div>` : ''}
        ${regen ? (regen.loading ? '<div class="msg"><span class="spin"></span> ШІ підбирає тайтли…</div>' : `
          <div class="msg ok">Нових карток: ${regen.items.filter((x) => !x.off).length} (натисніть на постер, щоб прибрати)</div>
          ${posters(regen.items, true)}
          ${regen.skipped.length ? `<div class="mut">Не знайдено в TMDB: ${esc(regen.skipped.join(', '))}</div>` : ''}
          <div class="mt"><button class="btn pri" data-act="apply-regen">Замінити картки</button> <button class="btn" data-act="cancel-regen">Скасувати</button></div>`) : ''}
        <div class="msg" data-msg-row></div>
      </div>`;
    }).join('')}`;
}

function viewIdea() {
  const ai = state.ai;
  const p = state.preview;
  main().innerHTML = `
    ${hero('<span>Нова ідея</span>', 'Опишіть ряд словами — ШІ запропонує тайтли, TMDB перевірить, що вони існують.')}
    ${aiReady() ? '' : '<div class="banner">ШІ не налаштовано: додайте ключ і модель. <button class="btn sm pri" data-act="goto" data-to="ai">ШІ-провайдер</button></div>'}
    <div class="grid">
      <div class="blk c5">
        <div class="bh"><span class="bi">✦</span><b>Ідея</b></div>
        <label class="f" for="idea-text">Що показати</label>
        <textarea class="inp" id="idea-text" maxlength="1000" placeholder="Наприклад: затишні осінні фільми з гарною українською озвучкою">${esc(p ? p.idea : '')}</textarea>
        <div class="fl">
          <div><label class="f" for="idea-kind">Тип</label><select class="inp" id="idea-kind">${options(KIND, p ? p.kind : 'movies')}</select></div>
          <div><label class="f" for="idea-style">Картки</label><select class="inp" id="idea-style">${options(STYLE, p ? p.style : 'poster')}</select></div>
          <div><label class="f" for="idea-count">Скільки</label><input class="inp" id="idea-count" type="number" min="5" max="30" value="${p ? p.count : 15}"></div>
        </div>
        <label class="f" for="idea-provider">Провайдер</label>
        <select class="inp" id="idea-provider">${options(Object.fromEntries(ai.providers.map((id) => [id, ai.info[id].label])), ai.provider)}</select>
        <button class="btn pri" data-act="generate">Згенерувати</button>
        <div class="msg" id="idea-msg"></div>
      </div>
      <div class="blk c7">
        <div class="bh"><span class="bi">▦</span><b>Прев'ю</b></div>
        ${p && p.items ? `
          ${posters(p.items, true)}
          ${p.skipped.length ? `<div class="mut mt">Не знайдено в TMDB: ${esc(p.skipped.join(', '))}</div>` : ''}
          <div class="fl mt">
            <div><label class="f" for="save-title">Назва ряду</label><input class="inp" id="save-title" maxlength="100" value="${esc(p.title || '')}"></div>
            <div><label class="f" for="save-target">Куди</label><select class="inp" id="save-target">
              <option value="new">Новий ряд у кінці</option>
              ${state.rows.map((r) => `<option value="${esc(r.id)}">Замінити: ${esc(r.title)}</option>`).join('')}
            </select></div>
          </div>
          <button class="btn pri" data-act="save-preview">Зберегти ряд</button>
          <div class="msg" id="save-msg"></div>` : '<div class="empty">Тут з’являться знайдені тайтли.</div>'}
      </div>
    </div>`;
}

const PROVIDER_NOTES = {
  gemini: 'Ключ — Google AI Studio. Безплатні моделі Flash / Flash-Lite.',
  groq: 'Ключ — Groq console. На безплатному рівні моделі обмежені кількістю токенів на хвилину.',
  openrouter: 'Ключ — openrouter.ai. Безплатні моделі мають суфікс «:free» (без покупки кредитів — 50 запитів на день).',
  mistral: 'Ключ — Mistral console.',
  ollama: 'Ваша локальна модель: ідеї нікуди не йдуть. Ключ не потрібен. Адреса — сервер Ollama з /v1 у кінці.',
  custom: 'Будь-який сервер з OpenAI-сумісним API (chat/completions). Ключ — якщо сервер його вимагає.',
};

function viewAi() {
  const ai = state.ai;
  const tab = state.aiTab || ai.provider || 'gemini';
  state.aiTab = tab;
  const info = ai.info[tab];
  const key = ai.keys[tab];
  const model = ai.models[tab] || '';
  const base = ai.bases[tab] || '';
  const canList = info.editable_base ? Boolean(base) : (key || !info.key_required);
  main().innerHTML = `
    ${hero('<span>ШІ-провайдер</span>', 'Ключі зберігаються лише на сервері й назад у браузер не віддаються.')}
    <div class="grid">
      <div class="blk c8">
        <div class="tabs">${ai.providers.map((id) => `<button data-act="ai-tab" data-p="${id}" class="${id === tab ? 'on' : ''}">${esc(ai.info[id].label)}${ai.provider === id ? ' · основний' : ''}</button>`).join('')}</div>
        <div class="mut mb">${esc(PROVIDER_NOTES[tab] || '')}</div>
        ${info.editable_base ? `
          <label class="f" for="ai-base">Адреса API</label>
          <input class="inp" id="ai-base" value="${esc(base)}" placeholder="${esc(info.example)}">
          <button class="btn pri" data-act="ai-save-base">Зберегти адресу</button>
          <div class="msg" id="ai-base-msg"></div>
          <hr class="sep">` : ''}
        <label class="f" for="ai-key">API-ключ${info.key_required ? '' : ' (необов’язково)'} ${key ? '— задано, введіть новий, щоб замінити' : '— не задано'}</label>
        <input class="inp" id="ai-key" type="password" autocomplete="off" placeholder="${key ? '••••••••' : 'вставте ключ'}">
        <button class="btn pri" data-act="ai-save-key">Зберегти ключ</button>
        ${key ? '<button class="btn bad" data-act="ai-clear-key">Видалити ключ</button>' : ''}
        <div class="msg" id="ai-key-msg"></div>
        <hr class="sep">
        <label class="f" for="ai-model">Модель</label>
        <div class="fl">
          <div><input class="inp" id="ai-model" list="ai-models" value="${esc(model)}" placeholder="оберіть зі списку або впишіть"><datalist id="ai-models"></datalist></div>
          <div class="noflex"><button class="btn" data-act="ai-models" ${canList ? '' : 'disabled'}>Завантажити список</button></div>
        </div>
        ${tab === 'openrouter' ? '<label class="chk"><input type="checkbox" id="ai-free" checked> лише безплатні (:free)</label>' : ''}
        <button class="btn pri" data-act="ai-save-model">Зберегти модель</button>
        ${ai.provider === tab ? '' : `<button class="btn" data-act="ai-main">Зробити ${esc(info.label)} основним</button>`}
        <div class="msg" id="ai-model-msg"></div>
      </div>
      <div class="blk c4">
        <div class="bh"><span class="bi">ⓘ</span><b>Як це працює</b></div>
        <div class="mut">До провайдера йдуть лише ідея ряду й назви тайтлів. Ні історії переглядів, ні даних пристроїв.<br><br>
        Один ряд — один запит до ШІ. Точні безплатні ліміти — у кабінеті самого провайдера.<br><br>
        Ollama на власному сервері не відправляє нічого назовні.</div>
      </div>
    </div>`;
}

function viewMcp() {
  const url = `${location.origin}/mcp`;
  main().innerHTML = `
    ${hero('<span>Доступ MCP</span>', 'Через MCP ШІ-асистент (наприклад, Claude Code) читає й змінює ряди.')}
    <div class="grid">
      <div class="blk c7">
        <div class="bh"><span class="bi">⌘</span><b>Адреса</b></div>
        <div class="secret">${esc(url)}</div>
        <div class="mut" id="mcp-info"></div>
        <hr class="sep">
        <button class="btn pri" data-act="mcp-token">Видати новий токен</button>
        <div class="mut mt">Старий токен одразу перестане діяти. Новий показується один раз.</div>
        <div id="mcp-new"></div>
      </div>
      <div class="blk c5">
        <div class="bh"><span class="bi">ⓘ</span><b>Запис змін</b></div>
        <div class="mut">Змінювати ряди через MCP можна, лише якщо на сервері <span class="mono">MCP_ENABLE_WRITES=true</span>.
        Кожен виклик запису несе фразу-підтвердження; ваш MCP-клієнт має питати вас перед ним.</div>
      </div>
    </div>`;
  api('GET', '/mcp').then((info) => {
    $('mcp-info').textContent = info.token_changed_at
      ? `Токен видано в кабінеті ${new Date(info.token_changed_at).toLocaleString('uk-UA')}.`
      : 'Діє токен із середовища сервера (MCP_TOKEN).';
  }).catch(() => {});
}

async function viewUsers() {
  main().innerHTML = `
    ${hero('<span>Користувачі</span>', 'Хто може входити в кабінет.')}
    ${defaultPasswordBanner()}
    <div class="grid">
      <div class="blk c6">
        <div class="bh"><span class="bi">🔑</span><b>Мій пароль</b></div>
        <label class="f" for="pw-cur">Поточний пароль</label><input class="inp" id="pw-cur" type="password" autocomplete="current-password">
        <label class="f" for="pw-new">Новий пароль (від 8 символів)</label><input class="inp" id="pw-new" type="password" autocomplete="new-password">
        <label class="f" for="pw-new2">Ще раз</label><input class="inp" id="pw-new2" type="password" autocomplete="new-password">
        <button class="btn pri" data-act="pw-save">Змінити пароль</button>
        <div class="msg" id="pw-msg"></div>
      </div>
      <div class="blk c6">
        <div class="bh"><span class="bi">◉</span><b>Користувачі</b></div>
        <div id="users-list"><div class="empty"><span class="spin"></span></div></div>
        <hr class="sep">
        <div class="fl">
          <div><label class="f" for="nu-name">Логін</label><input class="inp" id="nu-name" autocomplete="off"></div>
          <div><label class="f" for="nu-pass">Пароль</label><input class="inp" id="nu-pass" type="password" autocomplete="new-password"></div>
        </div>
        <button class="btn pri" data-act="user-add">Додати користувача</button>
        <div class="msg" id="nu-msg"></div>
      </div>
    </div>`;
  const { users } = await api('GET', '/users');
  $('users-list').innerHTML = users.map((u) => `<div class="row">
      <div class="ico">${esc(u.username.slice(0, 1).toUpperCase())}</div>
      <div><b>${esc(u.username)}${u.username === state.me.username ? ' (ви)' : ''}</b><small>${u.created_at ? `з ${esc(new Date(u.created_at).toLocaleDateString('uk-UA'))}` : ''}</small></div>
      <div class="end">${u.username === state.me.username ? '' : `<button class="btn sm bad" data-act="user-del" data-u="${esc(u.username)}">Видалити</button>`}</div>
    </div>`).join('');
}

// First login with the default password: nothing else works until it is changed (the server enforces it).
function viewFirstPassword() {
  document.querySelectorAll('#nav .ni').forEach((b) => { b.disabled = true; b.classList.remove('on'); });
  $('status').className = 'st hide-s w';
  $('status').querySelector('span').textContent = 'Потрібен новий пароль';
  main().innerHTML = `
    ${hero('<span>Спершу — новий пароль</span>', 'Ви увійшли з паролем за замовчуванням. Поки його не змінено, кабінет закритий.')}
    <div class="grid"><div class="blk c6">
      <div class="bh"><span class="bi">🔑</span><b>Новий пароль</b></div>
      <label class="f" for="pw-cur">Поточний пароль</label><input class="inp" id="pw-cur" type="password" autocomplete="current-password">
      <label class="f" for="pw-new">Новий пароль (від 8 символів)</label><input class="inp" id="pw-new" type="password" autocomplete="new-password">
      <label class="f" for="pw-new2">Ще раз</label><input class="inp" id="pw-new2" type="password" autocomplete="new-password">
      <button class="btn pri" data-act="pw-first">Змінити й увійти</button>
      <div class="msg" id="pw-msg"></div>
    </div></div>`;
}

async function viewCub() {
  main().innerHTML = `
    ${hero('<span>Журнал CUB</span>', 'Що Lampa просила в «CUB» через Lampac. Відповідає локальна заглушка, назовні нічого не йде.')}
    <div class="blk">
      <div class="bh"><span class="bi">⛨</span><b>Останні запити</b><div class="r"><button class="lnk" data-act="cub-refresh">Оновити</button></div></div>
      <div id="cub-list"><div class="empty"><span class="spin"></span></div></div>
      <div class="mut mt">Лише шляхи, без параметрів запиту. Журнал живе до перезапуску сервера.</div>
    </div>`;
  const { requests } = await api('GET', '/cub-log');
  $('nav-cub').textContent = requests.length || '';
  $('cub-list').innerHTML = requests.length ? requests.slice().reverse().map((r) => `<div class="ev">
      <span class="t">${esc(new Date(r.time).toLocaleTimeString('uk-UA'))}</span><span class="t">${esc(r.method)}</span><code>${esc(r.path)}</code></div>`).join('')
    : '<div class="empty">Запитів ще не було.</div>';
}

/* ---------- actions ---------- */

function rowOf(el) {
  const box = el.closest('[data-row]');
  return box ? state.rows.find((r) => r.id === box.dataset.row) : null;
}

async function saveRow(row, changes) {
  const data = await api('PUT', `/rows/${encodeURIComponent(row.id)}`, changes);
  state.rows = data.rows || [];
  $('nav-rows').textContent = state.rows.length || '';
}

const actions = {
  async logout() { await api('POST', '/logout', {}); showLogin(); },
  goto(el) { show(el.dataset.to); },

  async move(el) {
    const row = rowOf(el);
    const i = state.rows.indexOf(row);
    const to = i + Number(el.dataset.dir);
    if (to < 0 || to >= state.rows.length) return;
    await saveRow(row, { position: to });
    viewRows();
  },
  edit(el) { state.edit = rowOf(el).id; viewRows(); },
  'cancel-edit'() { state.edit = null; viewRows(); },
  async 'save-edit'(el) {
    const box = el.closest('[data-row]');
    const row = rowOf(el);
    const get = (f) => box.querySelector(`[data-f="${f}"]`).value;
    try {
      await saveRow(row, { title: get('title').trim(), kind: get('kind'), style: get('style'), idea: get('idea').trim() });
      state.edit = null;
      viewRows();
    } catch (error) { message(box.querySelector('[data-msg]'), error.message, false); }
  },
  async delete(el) {
    const row = rowOf(el);
    if (!confirm(`Видалити ряд «${row.title}»?`)) return;
    const data = await api('DELETE', `/rows/${encodeURIComponent(row.id)}`);
    state.rows = data.rows || [];
    $('nav-rows').textContent = state.rows.length || '';
    viewRows();
  },
  async regen(el) {
    const row = rowOf(el);
    state.regen[row.id] = { loading: true };
    viewRows();
    try {
      const res = await api('POST', '/generate', { idea: row.idea, kind: row.kind, count: Math.max((row.items || []).length, 10) });
      state.regen[row.id] = { items: res.items, skipped: res.skipped };
    } catch (error) {
      delete state.regen[row.id];
      viewRows();
      message(document.querySelector(`[data-row="${CSS.escape(row.id)}"] [data-msg-row]`), error.message, false);
      return;
    }
    viewRows();
  },
  'cancel-regen'(el) { delete state.regen[rowOf(el).id]; viewRows(); },
  async 'apply-regen'(el) {
    const row = rowOf(el);
    const items = state.regen[row.id].items.filter((x) => !x.off);
    await saveRow(row, { items });
    delete state.regen[row.id];
    viewRows();
  },
  'toggle-card'(el) {
    const i = Number(el.dataset.i);
    const row = rowOf(el);
    const list = row ? state.regen[row.id].items : state.preview.items;
    list[i].off = !list[i].off;
    if (row) viewRows(); else viewIdea();
  },

  async generate(el) {
    const idea = $('idea-text').value.trim();
    const params = { idea, kind: $('idea-kind').value, style: $('idea-style').value, count: Number($('idea-count').value) || 15, provider: $('idea-provider').value };
    if (!idea) return message($('idea-msg'), 'Опишіть ідею.', false);
    el.disabled = true;
    $('idea-msg').className = 'msg';
    $('idea-msg').innerHTML = '<span class="spin"></span> ШІ підбирає тайтли, TMDB перевіряє…';
    try {
      const res = await api('POST', '/generate', params);
      state.preview = { ...params, items: res.items, skipped: res.skipped, title: idea.length > 60 ? `${idea.slice(0, 57)}…` : idea };
      viewIdea();
      message($('idea-msg'), `Знайдено ${res.items.length} з ${res.proposed} запропонованих.`, true);
    } catch (error) {
      el.disabled = false;
      message($('idea-msg'), error.message, false);
    }
  },
  async 'save-preview'() {
    const p = state.preview;
    const items = p.items.filter((x) => !x.off);
    const title = $('save-title').value.trim();
    const target = $('save-target').value;
    if (!title) return message($('save-msg'), 'Дайте ряду назву.', false);
    if (!items.length) return message($('save-msg'), 'Нема жодної картки.', false);
    const id = target === 'new' ? `${p.kind}-${Date.now().toString(36)}` : target;
    try {
      const data = await api('PUT', `/rows/${encodeURIComponent(id)}`, { title, kind: p.kind, style: p.style, idea: p.idea, items });
      state.rows = data.rows || [];
      state.preview = null;
      $('nav-rows').textContent = state.rows.length || '';
      show('rows');
    } catch (error) { message($('save-msg'), error.message, false); }
  },

  'ai-tab'(el) { state.aiTab = el.dataset.p; viewAi(); },
  async 'ai-save-key'() {
    const key = $('ai-key').value.trim();
    if (!key) return message($('ai-key-msg'), 'Вставте ключ.', false);
    const body = { keys: { [state.aiTab]: key } };
    if (!state.ai.provider) body.provider = state.aiTab;
    state.ai = await api('PUT', '/ai', body);
    await refresh();
    viewAi();
    message($('ai-key-msg'), 'Ключ збережено.', true);
  },
  async 'ai-clear-key'() {
    if (!confirm(`Видалити ключ ${providerLabel(state.aiTab)}?`)) return;
    state.ai = await api('PUT', '/ai', { keys: { [state.aiTab]: '' } });
    await refresh();
    viewAi();
  },
  async 'ai-models'(el) {
    el.disabled = true;
    message($('ai-model-msg'), 'Питаю провайдера…', true);
    try {
      const { models } = await api('POST', '/ai/models', { provider: state.aiTab });
      const free = $('ai-free') && $('ai-free').checked;
      const shown = free ? models.filter((m) => /:free$/.test(m)) : models;
      $('ai-models').innerHTML = shown.map((m) => `<option value="${esc(m)}">`).join('');
      message($('ai-model-msg'), `Провайдер відповів. Моделей: ${shown.length}${free ? ' безплатних' : ''} — оберіть у полі «Модель».`, true);
    } catch (error) { message($('ai-model-msg'), error.message, false); }
    el.disabled = false;
  },
  async 'ai-save-model'() {
    const model = $('ai-model').value.trim();
    if (!model) return message($('ai-model-msg'), 'Оберіть модель.', false);
    state.ai = await api('PUT', '/ai', { models: { [state.aiTab]: model } });
    await refresh();
    viewAi();
    message($('ai-model-msg'), 'Модель збережено.', true);
  },
  async 'ai-save-base'() {
    try {
      state.ai = await api('PUT', '/ai', { bases: { [state.aiTab]: $('ai-base').value.trim() } });
      await refresh();
      viewAi();
      message($('ai-base-msg'), 'Адресу збережено.', true);
    } catch (error) { message($('ai-base-msg'), error.message, false); }
  },
  async 'ai-main'() {
    state.ai = await api('PUT', '/ai', { provider: state.aiTab });
    await refresh();
    viewAi();
  },

  async 'mcp-token'() {
    if (!confirm('Видати новий токен? Старий одразу перестане діяти.')) return;
    const { token } = await api('POST', '/mcp-token', {});
    const url = `${location.origin}/mcp`;
    const cmd = `claude mcp add --transport http lampac-mcp ${url} --header "Authorization: Bearer ${token}"`;
    $('mcp-new').innerHTML = `
      <div class="msg ok">Новий токен (показується один раз):</div>
      <div class="secret" id="tok">${esc(token)}</div>
      <button class="btn sm" data-act="copy" data-src="tok">Копіювати токен</button>
      <div class="mut mt">Claude Code:</div>
      <div class="secret" id="cmd">${esc(cmd)}</div>
      <button class="btn sm" data-act="copy" data-src="cmd">Копіювати команду</button>`;
      viewMcpInfo();
  },
  copy(el) { copy($(el.dataset.src).textContent, el); },

  async 'pw-save'() {
    const cur = $('pw-cur').value;
    const next = $('pw-new').value;
    if (next !== $('pw-new2').value) return message($('pw-msg'), 'Паролі не збігаються.', false);
    try {
      await api('POST', '/password', { current: cur, next });
      state.me.default_password = false;
      ['pw-cur', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; });
      viewUsers().then(() => message($('pw-msg'), 'Пароль змінено.', true));
    } catch (error) { message($('pw-msg'), error.message, false); }
  },
  async 'pw-first'() {
    const next = $('pw-new').value;
    if (next !== $('pw-new2').value) return message($('pw-msg'), 'Паролі не збігаються.', false);
    try {
      await api('POST', '/password', { current: $('pw-cur').value, next });
      document.querySelectorAll('#nav .ni').forEach((b) => { b.disabled = false; });
      await start();
    } catch (error) { message($('pw-msg'), error.message, false); }
  },
  async 'user-add'() {
    try {
      await api('POST', '/users', { username: $('nu-name').value.trim(), password: $('nu-pass').value });
      await viewUsers();
      message($('nu-msg'), 'Користувача додано.', true);
    } catch (error) { message($('nu-msg'), error.message, false); }
  },
  async 'user-del'(el) {
    if (!confirm(`Видалити користувача ${el.dataset.u}?`)) return;
    await api('DELETE', `/users/${encodeURIComponent(el.dataset.u)}`);
    await viewUsers();
  },
  'cub-refresh'() { viewCub(); },
};

function viewMcpInfo() {
  api('GET', '/mcp').then((info) => {
    if ($('mcp-info')) $('mcp-info').textContent = info.token_changed_at ? `Токен видано в кабінеті ${new Date(info.token_changed_at).toLocaleString('uk-UA')}.` : '';
  }).catch(() => {});
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const action = actions[el.dataset.act];
  if (!action) return;
  event.preventDefault();
  try { await action(el); } catch (error) { alert(error.message); }
});

api('GET', '/me').then(start).catch(() => showLogin());

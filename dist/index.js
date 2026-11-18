// Explorer plugin for CloudCLI: a lazy, folder-at-a-time file browser.
//
// The built-in Files tab loads the whole project tree up front, which breaks on
// large shared archives. This tab asks the plugin server for one folder at a time,
// searches by name on the server, and streams files for preview and download.

const PLUGIN = 'explorer';
const RPC_BASE = `/api/plugins/${PLUGIN}/rpc/`;
const PAGE = 300;
const UPLOAD_CHUNK = 4 * 1024 * 1024;
const TEXT_PREVIEW_MAX = 1024 * 1024;
const BLOB_PREVIEW_MAX = 200 * 1024 * 1024;

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const VIDEO = new Set(['mp4', 'webm']);
const AUDIO = new Set(['mp3', 'wav', 'ogg']);
const TEXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'html', 'js', 'ts', 'py', 'sh', 'yml', 'yaml', 'ini', 'dxf']);
const KIND = {
  pdf: 'pdf', doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', xls: 'xls', xlsx: 'xls', ods: 'xls', csv: 'xls',
  dwg: 'cad', dxf: 'cad', ifc: 'cad', zip: 'zip', rar: 'zip', '7z': 'zip', gz: 'zip', tar: 'zip',
};

// ── Small helpers ────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const joinRel = (a, b) => (a ? `${a}/${b}` : b);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`explorer:${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`explorer:${k}`, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

function fmtSize(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} Б`;
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '');

function authHeaders() {
  let token = null;
  try {
    token = localStorage.getItem('auth-token');
  } catch { /* storage unavailable */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Calls the plugin server through the host proxy, keeping the host's token refresh. */
async function call(method, route, { query, body, signal } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${RPC_BASE}${route}${qs}`, {
    method,
    signal,
    headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const refreshed = res.headers.get('X-Refreshed-Token');
  if (refreshed) {
    try {
      localStorage.setItem('auth-token', refreshed);
    } catch { /* storage unavailable */ }
  }
  if (route === 'raw' && res.ok) return res;
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON error page */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Сессия CloudCLI истекла — обновите страницу и войдите снова.');
    throw Object.assign(new Error(data?.error || data?.message || `Ошибка ${res.status}`), {
      status: res.status, conflict: !!data?.conflict, canReplace: !!data?.canReplace,
    });
  }
  return data;
}

/**
 * URL the browser can download from directly, so big files and ZIPs stream to disk
 * instead of being held in memory. A plain navigation cannot send headers, so the
 * CloudCLI token goes in `?token=`, which the host accepts (it does the same for its
 * WebSockets).
 */
function directUrl(route, query) {
  let token = null;
  try {
    token = localStorage.getItem('auth-token');
  } catch { /* storage unavailable */ }
  return `${RPC_BASE}${route}?${new URLSearchParams({ ...query, ...(token ? { token } : {}) })}`;
}

function saveAs(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Icons (24px, stroke) ─────────────────────────────────────────────────

const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  up: '<path d="m15 18-6-6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  newFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  zip: '<path d="M21 8v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8"/><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M10 12h4"/>',
  copyTo: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/><path d="M12 14.5h5M14.5 12v5"/>',
  moveTo: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6M13 10.5l2.5 2.5-2.5 2.5"/>',
  git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 8.2v7.6M18 11.2c0 3-3 3.8-6 4.3-2 .3-4 .9-5.2 1.6"/>',
};
const icon = (name, cls = '') => `<svg class="ex-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;

function entryIcon(e) {
  if (e.type === 'dir') return icon('folder', 'ex-k-dir');
  if (IMAGE.has(e.ext)) return icon('image', 'ex-k-img');
  const kind = KIND[e.ext];
  const badge = kind ? `<span class="ex-badge ex-k-${kind}">${esc(e.ext.slice(0, 4).toUpperCase())}</span>` : '';
  return `<span class="ex-fileic">${icon('file', kind ? `ex-k-${kind}` : '')}${badge}</span>`;
}

// ── Styles (host CSS variables, HSL triplets, with fallbacks) ────────────

const v = (name, fb) => `hsl(var(--${name}, ${fb}))`;
const CSS = `
.ex{--ex-bg:${v('background', '0 0% 8%')};--ex-card:${v('card', '0 0% 12%')};--ex-fg:${v('foreground', '45 12% 93%')};
--ex-muted:${v('muted-foreground', '45 4% 56%')};--ex-border:${v('border', '0 1% 16%')};--ex-hover:${v('accent', '0 1% 17%')};
--ex-primary:${v('primary', '15 65% 63%')};--ex-danger:${v('destructive', '10 72% 67%')};--ex-r:var(--radius,.625rem);
position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ex-bg);color:var(--ex-fg);
font:14px/1.4 Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-tap-highlight-color:transparent}
.ex *{box-sizing:border-box}
.ex-ic{width:18px;height:18px;flex:none}
.ex-head{flex:none;padding:10px 12px 8px;border-bottom:1px solid var(--ex-border);display:flex;flex-direction:column;gap:8px}
.ex-row{display:flex;align-items:center;gap:6px;min-width:0}
.ex-crumbs{display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0;white-space:nowrap}
.ex-crumbs::-webkit-scrollbar{display:none}
.ex-crumb{border:0;background:none;color:var(--ex-muted);padding:4px 6px;border-radius:6px;font:inherit;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.ex-crumb:last-child{color:var(--ex-fg);font-weight:600}
.ex-sep{color:var(--ex-muted);opacity:.6}
.ex-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:36px;height:36px;padding:0 9px;border:1px solid var(--ex-border);
background:var(--ex-card);color:var(--ex-fg);border-radius:calc(var(--ex-r) - 2px);font:inherit;cursor:pointer;flex:none}
.ex-btn:disabled{opacity:.45;cursor:default}
.ex-btn.on{border-color:var(--ex-primary);color:var(--ex-primary)}
.ex-btn.primary{background:var(--ex-primary);border-color:var(--ex-primary);color:hsl(var(--primary-foreground,0 0% 100%))}
.ex-btn.danger{background:var(--ex-danger);border-color:var(--ex-danger);color:#fff}
.ex-btn.danger-outline{background:transparent;border-color:var(--ex-danger);color:var(--ex-danger)}
.ex-search{flex:1;min-width:0;position:relative}
.ex-search .ex-ic{position:absolute;left:10px;top:9px;color:var(--ex-muted)}
.ex-input{width:100%;height:36px;padding:0 10px 0 34px;border:1px solid var(--ex-border);border-radius:calc(var(--ex-r) - 2px);
background:var(--ex-card);color:var(--ex-fg);font:inherit;font-size:16px;outline:none}
.ex-input:focus{border-color:var(--ex-primary)}
.ex-select{height:36px;border:1px solid var(--ex-border);border-radius:calc(var(--ex-r) - 2px);background:var(--ex-card);color:var(--ex-fg);font:inherit;padding:0 6px;flex:0 1 auto;min-width:0;max-width:170px}
.ex-status{font-size:12px;color:var(--ex-muted);min-height:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ex-status .err{color:var(--ex-danger)}
.ex-bar{height:3px;background:var(--ex-border);border-radius:2px;overflow:hidden;flex:1;min-width:80px}
.ex-bar>i{display:block;height:100%;background:var(--ex-primary);transition:width .2s}
.ex-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 0 24px}
.ex-item{display:flex;align-items:center;gap:10px;padding:8px 6px 8px 12px;min-height:52px;cursor:pointer;border-bottom:1px solid transparent}
.ex-item .ex-name{flex:1;min-width:0}
.ex-name b{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-name small{display:block;color:var(--ex-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-item .ex-ic{width:22px;height:22px}
.ex-fileic{position:relative;display:inline-flex;flex:none}
.ex-badge{position:absolute;left:-6px;bottom:-3px;font-size:8px;font-weight:700;line-height:1;padding:2px 3px;border-radius:3px;
background:currentColor;-webkit-text-fill-color:#fff;letter-spacing:.02em}
.ex-k-dir{color:hsl(38 80% 58%)}
.ex-k-pdf{color:hsl(4 70% 58%)} .ex-k-doc{color:hsl(214 75% 60%)} .ex-k-xls{color:hsl(142 50% 45%)}
.ex-k-cad{color:hsl(280 50% 65%)} .ex-k-zip{color:hsl(30 60% 55%)} .ex-k-img{color:hsl(190 60% 50%)}
.ex-item .ex-linkic{width:13px;height:13px;vertical-align:-2px;opacity:.7}
.ex-crumb{display:inline-flex;align-items:center;gap:4px}
.ex-more{border:0;background:none;color:var(--ex-muted);width:40px;height:40px;border-radius:8px;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center}
.ex-empty{padding:48px 20px;text-align:center;color:var(--ex-muted)}
.ex-showmore{display:block;margin:12px auto}
.ex-overlay{position:absolute;inset:0;z-index:20;background:rgb(0 0 0 / .5);display:flex;align-items:flex-end;justify-content:center}
@media (min-width:640px){.ex-overlay{align-items:center}}
.ex-sheet{width:100%;max-width:440px;background:var(--ex-card);border:1px solid var(--ex-border);border-radius:16px 16px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom))}
@media (min-width:640px){.ex-sheet{border-radius:var(--ex-r)}}
.ex-sheet h3{margin:2px 4px 4px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.ex-sheet p{margin:0 4px 12px;color:var(--ex-muted);font-size:13px;overflow-wrap:anywhere}
.ex-sheet .ex-input{padding-left:10px;margin-bottom:12px}
.ex-acts{display:flex;justify-content:flex-end;gap:8px}
.ex-menu{display:flex;flex-direction:column}
.ex-menu button{display:flex;align-items:center;gap:12px;border:0;background:none;color:var(--ex-fg);font:inherit;text-align:left;padding:12px 8px;border-radius:8px;cursor:pointer}
.ex-menu button.danger{color:var(--ex-danger)}
.ex-preview{position:absolute;inset:0;z-index:15;background:var(--ex-bg);display:flex;flex-direction:column}
.ex-preview .ex-head{flex-direction:row;align-items:center}
.ex-ptitle{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-pbody{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:8px}
.ex-pbody img,.ex-pbody video{max-width:100%;max-height:100%;object-fit:contain}
.ex-pbody iframe{width:100%;height:100%;border:0;background:#fff;border-radius:6px}
.ex-pbody pre{align-self:stretch;width:100%;margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 'Geist Mono',ui-monospace,monospace}
.ex-pbody .ex-empty{max-width:360px}
.ex-hidden{display:none!important}
.ex-picker{display:flex;flex-direction:column;max-height:min(82vh,640px)}
.ex-pcrumbs{display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;white-space:nowrap;margin:0 0 6px}
.ex-pcrumbs::-webkit-scrollbar{display:none}
.ex-plist{flex:1;min-height:140px;overflow-y:auto;border:1px solid var(--ex-border);border-radius:calc(var(--ex-r) - 2px);margin-bottom:8px}
.ex-prow{display:flex;align-items:center;gap:10px;padding:11px 12px;cursor:pointer;border-bottom:1px solid var(--ex-border)}
.ex-prow:last-child{border-bottom:0}
.ex-prow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-prow:active{background:var(--ex-hover)}
.ex-pnote{font-size:12px;min-height:16px;margin:0 2px 8px;color:var(--ex-muted)}
.ex-pnote.bad{color:var(--ex-danger)}
.ex-sheet .ex-acts{flex-wrap:wrap}
@media (hover:hover){.ex-crumb:hover,.ex-btn:not(:disabled):hover,.ex-item:hover,.ex-menu button:hover,.ex-prow:hover{background:var(--ex-hover)}
.ex-more:hover{background:var(--ex-card);color:var(--ex-fg)}}
.ex-item:active,.ex-menu button:active{background:var(--ex-hover)}
`;

// ── Mount ────────────────────────────────────────────────────────────────

export function mount(container, api) {
  const s = {
    root: null,
    cwd: '',
    entries: [],
    shown: PAGE,
    results: null, // search results, or null in folder mode
    query: '',
    sort: store.get('sort', 'name'),
    hidden: store.get('hidden', false),
    gitignore: store.get('gitignore', true),
    ignoredCount: 0,
    loading: false,
    error: '',
    note: '',
    progress: null, // { label, pct }
    seq: 0,
    abort: null,
    urls: [],
  };

  container.innerHTML = `<div class="ex"><style>${CSS}</style>
    <div class="ex-head">
      <div class="ex-row">
        <button class="ex-btn" data-a="up" title="Вверх" aria-label="Вверх">${icon('up')}</button>
        <div class="ex-crumbs"></div>
      </div>
      <div class="ex-row">
        <div class="ex-search">${icon('search')}<input class="ex-input" type="search" enterkeyhint="search"
          placeholder="Фильтр · Enter — поиск глубже" aria-label="Поиск"></div>
        <button class="ex-btn" data-a="search" title="Искать во вложенных папках" aria-label="Искать">${icon('search')}</button>
      </div>
      <div class="ex-row">
        <select class="ex-select" aria-label="Сортировка">
          <option value="name">По имени</option><option value="mtime">Сначала новые</option><option value="size">Сначала большие</option>
        </select>
        <span style="flex:1"></span>
        <button class="ex-btn" data-a="gitignore" title="Учитывать .gitignore" aria-label="Учитывать .gitignore">${icon('git')}</button>
        <button class="ex-btn" data-a="hidden" title="Скрытые файлы" aria-label="Скрытые файлы"></button>
        <button class="ex-btn" data-a="mkdir" title="Новая папка" aria-label="Новая папка">${icon('newFolder')}</button>
        <button class="ex-btn" data-a="upload" title="Загрузить файлы" aria-label="Загрузить">${icon('upload')}</button>
        <button class="ex-btn" data-a="refresh" title="Обновить" aria-label="Обновить">${icon('refresh')}</button>
      </div>
      <div class="ex-status"></div>
    </div>
    <div class="ex-list"></div>
    <input type="file" multiple class="ex-hidden">
  </div>`;

  const el = container.firstElementChild;
  const $ = (sel) => el.querySelector(sel);
  const crumbsEl = $('.ex-crumbs');
  const listEl = $('.ex-list');
  const statusEl = $('.ex-status');
  const inputEl = $('.ex-input');
  const sortEl = $('.ex-select');
  const fileEl = $('input[type=file]');
  sortEl.value = s.sort;

  const absOf = (rel) => (rel ? `${s.root}/${rel}` : s.root);
  const cwdKey = () => `cwd:${s.root}`;

  // ── Rendering ──

  function visible() {
    const hide = (e) => !s.hidden && e.name.startsWith('.');
    if (s.results) return s.results.filter((e) => !hide(e));
    const f = s.query.trim().toLocaleLowerCase('ru');
    const items = s.entries.filter((e) => !hide(e) && (!f || e.name.toLocaleLowerCase('ru').includes(f)));
    const byName = (a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
    const cmp = {
      name: byName,
      mtime: (a, b) => (b.mtime || 0) - (a.mtime || 0) || byName(a, b),
      size: (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b),
    }[s.sort];
    return items.sort((a, b) => (a.type === b.type ? cmp(a, b) : a.type === 'dir' ? -1 : 1));
  }

  function renderCrumbs() {
    const parts = s.cwd ? s.cwd.split('/') : [];
    const rootName = s.root ? s.root.split('/').filter(Boolean).pop() || '/' : '';
    let html = `<button class="ex-crumb" data-a="go" data-p="">${icon('home', '')} ${esc(rootName)}</button>`;
    parts.forEach((p, i) => {
      html += `<span class="ex-sep">/</span><button class="ex-crumb" data-a="go" data-p="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`;
    });
    crumbsEl.innerHTML = html;
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
    $('[data-a=up]').disabled = !s.cwd || !!s.results;
  }

  function renderStatus() {
    const bits = [];
    if (s.progress) {
      bits.push(`<span>${esc(s.progress.label)}</span>`);
      if (s.progress.pct !== null) bits.push(`<span class="ex-bar"><i style="width:${s.progress.pct}%"></i></span>`);
    } else if (s.error) {
      bits.push(`<span class="err">${esc(s.error)}</span>`);
    } else if (s.loading) {
      bits.push('<span>Загрузка…</span>');
    } else if (s.note) {
      bits.push(`<span>${esc(s.note)}</span>`);
    } else if (s.root) {
      const items = visible();
      const dirs = items.filter((e) => e.type === 'dir').length;
      bits.push(`<span>${s.results ? 'Найдено' : 'Папок'}: ${s.results ? items.length : `${dirs}, файлов: ${items.length - dirs}`}${!s.results && s.ignoredCount ? ` · скрыто по .gitignore: ${s.ignoredCount}` : ''}</span>`);
    }
    statusEl.innerHTML = bits.join('');
  }

  function renderList() {
    if (!s.root) {
      listEl.innerHTML = '<div class="ex-empty">Выберите проект слева, чтобы открыть его файлы.</div>';
      return;
    }
    const items = visible();
    if (!items.length) {
      listEl.innerHTML = `<div class="ex-empty">${s.loading ? 'Загрузка…' : s.results ? 'Ничего не найдено.' : s.query ? 'В этой папке ничего не подходит. Нажмите Enter, чтобы искать во вложенных.' : 'Папка пуста.'}</div>`;
      return;
    }
    const slice = items.slice(0, s.shown);
    s.view = slice;
    listEl.innerHTML = slice.map((e, i) => {
      const meta = [];
      if (s.results) meta.push(esc(parentOf(e.path) || '/'));
      if (e.broken) meta.push('битая ссылка');
      if (e.type === 'file') meta.push(fmtSize(e.size));
      meta.push(fmtDate(e.mtime));
      return `<div class="ex-item" data-i="${i}" role="button" tabindex="0">
        ${entryIcon(e)}
        <div class="ex-name"><b>${esc(e.name)}${e.link ? ` ${icon('link', 'ex-linkic')}` : ''}</b><small>${meta.filter(Boolean).join(' · ')}</small></div>
        <button class="ex-more" data-a="menu" data-i="${i}" aria-label="Действия">${icon('more')}</button>
      </div>`;
    }).join('') + (items.length > s.shown
      ? `<button class="ex-btn ex-showmore" data-a="showmore">Показать ещё ${Math.min(PAGE, items.length - s.shown)} из ${items.length - s.shown}</button>`
      : '');
  }

  function render() {
    $('[data-a=hidden]').innerHTML = icon(s.hidden ? 'eye' : 'eyeOff');
    $('[data-a=hidden]').classList.toggle('on', s.hidden);
    $('[data-a=gitignore]').classList.toggle('on', s.gitignore);
    $('[data-a=gitignore]').title = s.gitignore ? 'Учитывается .gitignore — нажмите, чтобы показать всё' : '.gitignore не учитывается — нажмите, чтобы учитывать';
    renderCrumbs();
    renderStatus();
    renderList();
  }

  // ── Data ──

  async function load(rel = s.cwd, { keepScroll = false } = {}) {
    if (!s.root) return render();
    s.abort?.abort();
    const ac = new AbortController();
    s.abort = ac;
    const seq = ++s.seq;
    s.loading = true;
    s.error = '';
    s.note = '';
    s.results = null;
    render();
    try {
      const data = await call('GET', 'list', { query: { root: s.root, path: rel, gitignore: s.gitignore ? '1' : '0' }, signal: ac.signal });
      if (seq !== s.seq) return;
      s.cwd = data.path;
      s.entries = data.entries;
      s.ignoredCount = data.ignored || 0;
      s.shown = PAGE;
      store.set(cwdKey(), s.cwd);
    } catch (err) {
      if (ac.signal.aborted || seq !== s.seq) return;
      s.error = err.message;
      if (rel && /Не найдено|не папка/i.test(err.message)) {
        // A remembered folder that no longer exists: fall back to its parent.
        s.loading = false;
        return load(parentOf(rel));
      }
    } finally {
      if (seq === s.seq) s.loading = false;
    }
    const top = listEl.scrollTop;
    render();
    listEl.scrollTop = keepScroll ? top : 0;
  }

  async function runSearch() {
    const q = inputEl.value.trim();
    if (!q || !s.root) return;
    s.abort?.abort();
    const ac = new AbortController();
    s.abort = ac;
    const seq = ++s.seq;
    s.loading = true;
    s.error = '';
    s.note = `Поиск «${q}»…`;
    s.results = [];
    render();
    try {
      const data = await call('GET', 'search', { query: { root: s.root, path: s.cwd, q, hidden: s.hidden ? '1' : '0', gitignore: s.gitignore ? '1' : '0' }, signal: ac.signal });
      if (seq !== s.seq) return;
      s.results = data.results;
      s.shown = PAGE;
      s.note = `Поиск «${q}» в «${s.cwd || 'корне проекта'}»: ${data.results.length}${data.incomplete ? '+ (показаны первые, уточните запрос)' : ''}. Очистите поле, чтобы вернуться.`;
    } catch (err) {
      if (ac.signal.aborted || seq !== s.seq) return;
      s.results = null;
      s.error = err.message;
    } finally {
      if (seq === s.seq) s.loading = false;
    }
    render();
    listEl.scrollTop = 0;
  }

  /** Fetches a file as a Blob, reporting download progress in the status line. */
  async function fetchBlob(e) {
    const res = await call('GET', 'raw', { query: { root: s.root, path: e.path ?? joinRel(s.cwd, e.name) } });
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      s.progress = { label: `Загрузка «${e.name}» ${fmtSize(got)} из ${fmtSize(total)}`, pct: Math.round((got / total) * 100) };
      renderStatus();
    }
    s.progress = null;
    renderStatus();
    return new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
  }

  function keepUrl(blob) {
    const url = URL.createObjectURL(blob);
    s.urls.push(url);
    return url;
  }

  function download(e) {
    saveAs(directUrl('raw', { root: s.root, path: e.path ?? joinRel(s.cwd, e.name), download: '1' }), e.name);
    s.error = '';
    s.note = `Скачивание «${e.name}» — ход виден в загрузках браузера`;
    renderStatus();
  }

  function downloadZip(e) {
    const rel = e.path ?? joinRel(s.cwd, e.name);
    saveAs(directUrl('zip', { root: s.root, path: rel, gitignore: s.gitignore ? '1' : '0', hidden: s.hidden ? '1' : '0' }), `${e.name}.zip`);
    s.error = '';
    s.note = `Архив «${e.name}.zip» собирается на лету и скачивается — ход виден в загрузках браузера`;
    renderStatus();
  }

  // ── Copy / move ──

  /** Folder picker: resolves to the chosen folder (relative path) or null. */
  function pickFolder({ title, ok, start, invalid }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'ex-overlay';
      ov.innerHTML = `<div class="ex-sheet ex-picker" role="dialog"><h3>${esc(title)}</h3>
        <div class="ex-pcrumbs"></div><div class="ex-plist"></div><div class="ex-pnote"></div>
        <div class="ex-acts"><button class="ex-btn" data-k="mkdir" title="Новая папка" aria-label="Новая папка">${icon('newFolder')}</button>
        <span style="flex:1"></span><button class="ex-btn" data-k="cancel">Отмена</button>
        <button class="ex-btn primary" data-k="ok">${esc(ok)}</button></div></div>`;
      const crumbs = ov.querySelector('.ex-pcrumbs');
      const plist = ov.querySelector('.ex-plist');
      const note = ov.querySelector('.ex-pnote');
      const okBtn = ov.querySelector('[data-k=ok]');
      let cur = start;
      let dirs = [];
      const close = (val) => {
        ov.remove();
        resolve(val);
      };
      const draw = (err = '') => {
        const parts = cur ? cur.split('/') : [];
        const rootName = s.root.split('/').filter(Boolean).pop() || '/';
        crumbs.innerHTML = `<button class="ex-crumb" data-go="">${icon('home')} ${esc(rootName)}</button>` + parts.map((p, i) =>
          `<span class="ex-sep">/</span><button class="ex-crumb" data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('');
        crumbs.scrollLeft = crumbs.scrollWidth;
        plist.innerHTML = dirs.length
          ? dirs.map((d, i) => `<div class="ex-prow" data-i="${i}">${icon('folder', 'ex-k-dir')}<span>${esc(d.name)}</span></div>`).join('')
          : `<div class="ex-empty" style="padding:24px 12px">${err ? esc(err) : 'Вложенных папок нет'}</div>`;
        const why = invalid(cur);
        okBtn.disabled = !!why || !!err;
        note.className = `ex-pnote${why ? ' bad' : ''}`;
        note.textContent = why || `Сюда: ${cur ? `/${cur}` : 'корень проекта'}`;
      };
      const go = async (rel) => {
        plist.innerHTML = '<div class="ex-empty" style="padding:24px 12px">Загрузка…</div>';
        try {
          const d = await call('GET', 'list', { query: { root: s.root, path: rel, gitignore: s.gitignore ? '1' : '0' } });
          cur = d.path;
          dirs = d.entries
            .filter((x) => x.type === 'dir' && (s.hidden || !x.name.startsWith('.')))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
          draw();
        } catch (err) {
          dirs = [];
          draw(err.message);
        }
      };
      ov.addEventListener('click', async (ev) => {
        if (ev.target === ov) return close(null);
        const c = ev.target.closest('[data-go]');
        if (c) return go(c.dataset.go);
        const row = ev.target.closest('.ex-prow');
        if (row) return go(joinRel(cur, dirs[Number(row.dataset.i)].name));
        const k = ev.target.closest('[data-k]')?.dataset.k;
        if (k === 'cancel') return close(null);
        if (k === 'ok' && !okBtn.disabled) return close(cur);
        if (k === 'mkdir') {
          const name = await ask({ title: 'Новая папка', value: 'Новая папка', ok: 'Создать' });
          if (!name) return;
          try {
            const r = await call('POST', 'mkdir', { body: { root: s.root, path: cur, name } });
            return go(r.path);
          } catch (err) {
            note.className = 'ex-pnote bad';
            note.textContent = err.message;
          }
        }
      });
      ov.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') close(null);
      });
      el.appendChild(ov);
      go(start);
    });
  }

  async function transferItem(e, op) {
    const rel = e.path ?? joinRel(s.cwd, e.name);
    const from = parentOf(rel);
    const isDir = e.type === 'dir';
    const verb = op === 'copy' ? 'Копировать' : 'Перенести';
    const dest = await pickFolder({
      title: `${verb} «${e.name}» в…`,
      ok: `${verb} сюда`,
      start: s.cwd,
      invalid: (d) => {
        if (isDir && (d === rel || d.startsWith(`${rel}/`))) return 'Нельзя положить папку внутрь неё самой';
        if (op === 'move' && d === from) return `«${e.name}» уже в этой папке`;
        return '';
      },
    });
    if (dest === null) return;
    let conflict;
    for (;;) {
      try {
        const { id } = await call('POST', 'transfer', { body: { root: s.root, op, path: rel, dest, conflict } });
        return watchJob(id, op, e.name, dest);
      } catch (err) {
        if (err.conflict && !conflict) {
          const choice = await dialog(`<h3>В папке уже есть «${esc(e.name)}»</h3>
            <p>${err.canReplace ? 'Заменить файл в папке назначения или сохранить оба (новый получит номер)?' : 'Сохранить оба? Новый получит номер в имени.'}</p>
            <div class="ex-acts"><button class="ex-btn" data-r="cancel">Отмена</button>
            ${err.canReplace ? '<button class="ex-btn danger-outline" data-r="replace">Заменить</button>' : ''}
            <button class="ex-btn primary" data-r="rename">Сохранить оба</button></div>`);
          if (choice !== 'replace' && choice !== 'rename') return;
          conflict = choice;
          continue;
        }
        s.error = err.message;
        renderStatus();
        return;
      }
    }
  }

  async function watchJob(id, op, name, dest) {
    const what = op === 'copy' ? 'Копирование' : 'Перенос';
    s.error = '';
    for (;;) {
      let j;
      try {
        j = await call('GET', 'job', { query: { id } });
      } catch (err) {
        s.progress = null;
        s.error = err.message;
        renderStatus();
        return;
      }
      if (j.status !== 'running') {
        s.progress = null;
        if (j.status === 'error') {
          s.error = `${what} «${name}»: ${j.error}`;
          renderStatus();
          return;
        }
        if (s.results) await runSearch();
        else await load(s.cwd, { keepScroll: true });
        s.note = `«${name}» ${op === 'copy' ? 'скопировано' : 'перенесено'} в «${dest ? `/${dest}` : 'корень проекта'}»${j.path && !j.path.endsWith(`/${name}`) && j.path !== name ? ` как «${j.path.split('/').pop()}»` : ''}`;
        renderStatus();
        return;
      }
      const label = j.phase === 'cleanup' ? `${what} «${name}»: удаление исходника…` : `${what} «${name}»: ${j.done} из ${j.total}`;
      s.progress = { label, pct: j.total > 1 ? Math.round((j.done / j.total) * 100) : null };
      renderStatus();
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // ── Dialogs ──

  function dialog(inner, onReady) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'ex-overlay';
      ov.innerHTML = `<div class="ex-sheet" role="dialog">${inner}</div>`;
      const close = (val) => {
        ov.remove();
        resolve(val);
      };
      ov.addEventListener('click', (ev) => {
        if (ev.target === ov) close(null);
        const b = ev.target.closest('[data-r]');
        if (b) close(b.dataset.r === 'ok' ? (ov.querySelector('input')?.value ?? true) : b.dataset.r === 'cancel' ? null : b.dataset.r);
      });
      ov.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') close(null);
        if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') close(ev.target.value);
      });
      el.appendChild(ov);
      onReady?.(ov);
    });
  }

  const ask = ({ title, text = '', value = null, ok = 'OK', danger = false }) => dialog(
    `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
     ${value !== null ? `<input class="ex-input" value="${esc(value)}" autocomplete="off">` : ''}
     <div class="ex-acts"><button class="ex-btn" data-r="cancel">Отмена</button>
     <button class="ex-btn ${danger ? 'danger' : 'primary'}" data-r="ok">${esc(ok)}</button></div>`,
    (ov) => {
      const inp = ov.querySelector('input');
      if (inp) {
        inp.focus();
        const dot = inp.value.lastIndexOf('.');
        inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
      }
    },
  );

  async function menu(e) {
    const isDir = e.type === 'dir';
    const pick = await dialog(`<h3>${esc(e.name)}</h3>
      <p>${isDir ? 'Папка' : fmtSize(e.size)} · ${esc(fmtDate(e.mtime))}${s.results ? ` · ${esc(parentOf(e.path) || '/')}` : ''}</p>
      <div class="ex-menu">
        ${isDir ? `<button data-r="open">${icon('folder')} Открыть</button><button data-r="zip">${icon('zip')} Скачать ZIP</button>` : `<button data-r="preview">${icon('eye')} Просмотр</button><button data-r="download">${icon('download')} Скачать</button>`}
        <button data-r="copyto">${icon('copyTo')} Копировать в…</button>
        <button data-r="moveto">${icon('moveTo')} Перенести в…</button>
        ${s.results ? `<button data-r="reveal">${icon('folder')} Показать в папке</button>` : ''}
        <button data-r="copy">${icon('copy')} Копировать путь</button>
        <button data-r="rename">${icon('edit')} Переименовать</button>
        <button data-r="delete" class="danger">${icon('trash')} Удалить</button>
      </div>`);
    const rel = e.path ?? joinRel(s.cwd, e.name);
    if (pick === 'open') return load(rel);
    if (pick === 'preview') return preview(e);
    if (pick === 'download') return download(e);
    if (pick === 'zip') return downloadZip(e);
    if (pick === 'copyto') return transferItem(e, 'copy');
    if (pick === 'moveto') return transferItem(e, 'move');
    if (pick === 'reveal') {
      inputEl.value = '';
      s.query = '';
      return load(parentOf(rel));
    }
    if (pick === 'copy') return copyPath(absOf(rel));
    if (pick === 'rename') {
      const name = await ask({ title: 'Переименовать', value: e.name, ok: 'Переименовать' });
      if (!name || name === e.name) return;
      return mutate('rename', { path: rel, newName: name }, `Переименовано в «${name}»`);
    }
    if (pick === 'delete') {
      const ok = await ask({
        title: isDir ? `Удалить папку «${e.name}»?` : `Удалить «${e.name}»?`,
        text: isDir ? 'Папка будет удалена вместе со всем содержимым. Восстановить её будет нельзя.' : 'Файл будет удалён без возможности восстановления.',
        ok: 'Удалить',
        danger: true,
      });
      if (ok) return mutate('delete', { path: rel }, `«${e.name}» удалено`);
    }
  }

  async function mutate(route, body, done) {
    try {
      await call('POST', route, { body: { root: s.root, ...body } });
      if (s.results) await runSearch();
      else await load(s.cwd, { keepScroll: true });
      s.note = done;
      renderStatus();
    } catch (err) {
      s.error = err.message;
      renderStatus();
    }
  }

  async function copyPath(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    s.error = '';
    s.note = `Скопировано: ${text}`;
    renderStatus();
  }

  // ── Preview ──

  async function preview(e) {
    const pv = document.createElement('div');
    pv.className = 'ex-preview';
    pv.innerHTML = `<div class="ex-head">
        <button class="ex-btn" data-p="close" aria-label="Закрыть">${icon('close')}</button>
        <div class="ex-ptitle">${esc(e.name)}</div>
        <button class="ex-btn" data-p="open" title="Открыть в новой вкладке" aria-label="Открыть в новой вкладке" disabled>${icon('external')}</button>
        <button class="ex-btn" data-p="download" title="Скачать" aria-label="Скачать">${icon('download')}</button>
      </div><div class="ex-pbody"><div class="ex-empty">Загрузка…</div></div>`;
    el.appendChild(pv);
    const body = pv.querySelector('.ex-pbody');
    let url = null;
    pv.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-p]');
      if (!b) return;
      if (b.dataset.p === 'close') pv.remove();
      if (b.dataset.p === 'download') download(e);
      if (b.dataset.p === 'open' && url) window.open(url, '_blank', 'noopener');
    });

    const ext = e.ext || '';
    const canBlob = e.size !== null && e.size <= BLOB_PREVIEW_MAX;
    const isText = TEXT.has(ext) && e.size <= TEXT_PREVIEW_MAX;
    if (!canBlob || !(IMAGE.has(ext) || VIDEO.has(ext) || AUDIO.has(ext) || ext === 'pdf' || isText)) {
      body.innerHTML = `<div class="ex-empty">Для «.${esc(ext || '—')}» просмотр в браузере недоступен${e.size > BLOB_PREVIEW_MAX ? ' (файл слишком большой)' : ''}.<br><br>
        <button class="ex-btn primary" data-p="download">${icon('download')} Скачать ${esc(fmtSize(e.size))}</button></div>`;
      return;
    }
    try {
      const blob = await fetchBlob(e);
      if (!pv.isConnected) return;
      if (isText) {
        const pre = document.createElement('pre');
        pre.textContent = await blob.text();
        body.replaceChildren(pre);
        body.style.alignItems = 'flex-start';
        return;
      }
      url = keepUrl(blob);
      pv.querySelector('[data-p=open]').disabled = false;
      if (IMAGE.has(ext)) body.innerHTML = `<img src="${url}" alt="${esc(e.name)}">`;
      else if (VIDEO.has(ext)) body.innerHTML = `<video src="${url}" controls playsinline></video>`;
      else if (AUDIO.has(ext)) body.innerHTML = `<audio src="${url}" controls></audio>`;
      else body.innerHTML = `<iframe src="${url}" title="${esc(e.name)}"></iframe>`;
    } catch (err) {
      s.progress = null;
      renderStatus();
      body.innerHTML = `<div class="ex-empty">${esc(err.message)}</div>`;
    }
  }

  // ── Upload ──

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function uploadFiles(files) {
    const dir = s.cwd;
    let done = 0;
    for (const f of files) {
      let overwrite = false;
      for (;;) {
        let id = null;
        try {
          let offset = 0;
          do {
            const end = Math.min(offset + UPLOAD_CHUNK, f.size);
            const data = toBase64(await f.slice(offset, end).arrayBuffer());
            s.progress = { label: `Отправка «${f.name}» (${done + 1}/${files.length}) ${fmtSize(end)} из ${fmtSize(f.size)}`, pct: f.size ? Math.round((end / f.size) * 100) : 100 };
            renderStatus();
            const r = await call('POST', 'upload', { body: { root: s.root, path: dir, name: f.name, id, offset, data, overwrite, final: end >= f.size } });
            id = r.id;
            offset = end;
          } while (offset < f.size);
          done++;
          break;
        } catch (err) {
          if (id) call('POST', 'upload-cancel', { body: { root: s.root, id } }).catch(() => {});
          if (!overwrite && /уже есть/.test(err.message)) {
            const ok = await ask({ title: `«${f.name}» уже есть`, text: 'Заменить файл в этой папке новым?', ok: 'Заменить', danger: true });
            if (ok) {
              overwrite = true;
              continue;
            }
            break;
          }
          s.progress = null;
          s.error = `«${f.name}»: ${err.message}`;
          renderStatus();
          return;
        }
      }
    }
    s.progress = null;
    if (s.cwd === dir && !s.results) await load(dir, { keepScroll: true });
    s.note = `Загружено файлов: ${done} из ${files.length}`;
    renderStatus();
  }

  // ── Events ──

  function onClick(ev) {
    const a = ev.target.closest('[data-a]');
    const row = ev.target.closest('.ex-item');
    if (ev.target.closest('.ex-overlay, .ex-preview')) return;
    if (a) {
      const act = a.dataset.a;
      if (act === 'menu') return menu(s.view[Number(a.dataset.i)]);
      if (act === 'go') {
        inputEl.value = '';
        s.query = '';
        return load(a.dataset.p);
      }
      if (act === 'up') return load(parentOf(s.cwd));
      if (act === 'refresh') return s.results ? runSearch() : load(s.cwd, { keepScroll: true });
      if (act === 'search') return runSearch();
      if (act === 'showmore') {
        s.shown += PAGE;
        return renderList();
      }
      if (act === 'hidden') {
        s.hidden = !s.hidden;
        store.set('hidden', s.hidden);
        return render();
      }
      if (act === 'gitignore') {
        s.gitignore = !s.gitignore;
        store.set('gitignore', s.gitignore);
        return s.results ? runSearch() : load(s.cwd, { keepScroll: true });
      }
      if (act === 'upload') return fileEl.click();
      if (act === 'mkdir') {
        return ask({ title: 'Новая папка', value: 'Новая папка', ok: 'Создать' }).then((name) => {
          if (name) mutate('mkdir', { path: s.cwd, name }, `Создана папка «${name}»`);
        });
      }
      return;
    }
    if (row) {
      const e = s.view[Number(row.dataset.i)];
      if (e.type === 'dir') {
        inputEl.value = '';
        s.query = '';
        return load(e.path ?? joinRel(s.cwd, e.name));
      }
      return preview(e);
    }
  }

  function onKey(ev) {
    if (ev.key === 'Enter' && ev.target.classList?.contains('ex-item')) ev.target.click();
  }

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  inputEl.addEventListener('input', () => {
    s.query = inputEl.value;
    if (s.results && !s.query.trim()) return load(s.cwd);
    if (!s.results) {
      s.shown = PAGE;
      renderList();
      renderStatus();
    }
  });
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runSearch();
    }
  });
  sortEl.addEventListener('change', () => {
    s.sort = sortEl.value;
    store.set('sort', s.sort);
    renderList();
  });
  fileEl.addEventListener('change', () => {
    const files = Array.from(fileEl.files || []);
    fileEl.value = '';
    if (files.length) uploadFiles(files);
  });

  function setProject(ctx) {
    const root = ctx?.project?.path || null;
    if (root === s.root) return;
    s.root = root;
    s.entries = [];
    s.results = null;
    inputEl.value = '';
    s.query = '';
    s.cwd = root ? store.get(`cwd:${root}`, '') : '';
    load(s.cwd);
  }

  const unsubscribe = api.onContextChange(setProject);
  setProject(api.context);

  container._explorerCleanup = () => {
    unsubscribe?.();
    s.abort?.abort();
    s.urls.forEach((u) => URL.revokeObjectURL(u));
    el.removeEventListener('click', onClick);
    el.removeEventListener('keydown', onKey);
  };
}

export function unmount(container) {
  container._explorerCleanup?.();
  delete container._explorerCleanup;
  container.innerHTML = '';
}

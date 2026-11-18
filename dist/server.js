// Explorer plugin backend for CloudCLI.
//
// The host spawns this file as the CloudCLI user (one process per user), proxies
// /api/plugins/explorer/rpc/* to it, and only forwards JSON request bodies. Every
// request names the project root it works in; paths are relative to that root and
// may never resolve outside it. File-system permissions of the user still apply.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Vendored `ignore` 7.0.16 (MIT, see vendor/ignore.LICENSE-MIT), the matcher
// CloudCLI itself uses, so the plugin installs without `npm install`.
const ignore = createRequire(import.meta.url)('./vendor/ignore.cjs');

const SEARCH_DEFAULT_LIMIT = 200;
const SEARCH_MAX_LIMIT = 1000;
const SEARCH_TIME_BUDGET_MS = 5000;
const SEARCH_MAX_VISITED = 300_000;
const SKIP_IN_SEARCH = new Set(['node_modules', '.git', '.svn', '.hg']);
const UPLOAD_TTL_MS = 60 * 60_000;

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', xml: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', dxf: 'text/plain; charset=utf-8',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Paths ────────────────────────────────────────────────────────────────

function requireRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new HttpError(400, 'Не указан корень проекта.');
  return path.resolve(root);
}

/** Resolves `rel` inside `root`; rejects anything that escapes it. */
function inside(root, rel = '') {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, 'Недопустимый путь.');
  const abs = path.resolve(root, `.${path.sep}${rel}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(403, 'Путь вне проекта.');
  return abs;
}

function relOf(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new HttpError(400, 'Недопустимое имя.');
  }
  if (Buffer.byteLength(name) > 255) throw new HttpError(400, 'Слишком длинное имя.');
  return name;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function fsError(err) {
  if (err instanceof HttpError) return err;
  switch (err?.code) {
    case 'ENOENT': return new HttpError(404, 'Не найдено.');
    case 'EACCES':
    case 'EPERM': return new HttpError(403, 'Нет доступа.');
    case 'EEXIST':
    case 'ENOTEMPTY': return new HttpError(409, 'Уже существует.');
    case 'ENOTDIR': return new HttpError(400, 'Это не папка.');
    case 'EISDIR': return new HttpError(400, 'Это папка.');
    case 'ENOSPC': return new HttpError(507, 'На сервере закончилось место.');
    default: return new HttpError(500, err?.message || 'Ошибка файловой системы.');
  }
}

// ── .gitignore ───────────────────────────────────────────────────────────
// Git semantics: every .gitignore from the project root down to the folder
// applies, each relative to its own folder, and a deeper file may re-include
// (`!pattern`) what a shallower one excluded.

const GITIGNORE_CACHE_MAX = 5000;
const gitignoreCache = new Map(); // folder → { mtime, size, ig }

async function gitignoreIn(dir) {
  let st;
  try {
    st = await fsp.stat(path.join(dir, '.gitignore'));
  } catch {
    gitignoreCache.delete(dir);
    return null;
  }
  if (!st.isFile()) return null;
  const hit = gitignoreCache.get(dir);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.ig;
  let ig = null;
  try {
    ig = ignore().add(await fsp.readFile(path.join(dir, '.gitignore'), 'utf8'));
  } catch { /* unreadable: ignore nothing */ }
  if (gitignoreCache.size >= GITIGNORE_CACHE_MAX) gitignoreCache.clear();
  gitignoreCache.set(dir, { mtime: st.mtimeMs, size: st.size, ig });
  return ig;
}

/** Matchers that apply inside `dir`: the root's .gitignore first, `dir`'s own last. */
async function matchersFor(root, dir) {
  const parts = relOf(root, dir).split('/').filter(Boolean);
  const out = [];
  let cur = root;
  for (let i = 0; i <= parts.length; i++) {
    if (i) cur = path.join(cur, parts[i - 1]);
    const ig = await gitignoreIn(cur);
    if (ig) out.push({ base: cur, ig });
  }
  return out;
}

async function withOwnMatcher(parentMatchers, dir) {
  const ig = await gitignoreIn(dir);
  return ig ? [...parentMatchers, { base: dir, ig }] : parentMatchers;
}

function isIgnored(matchers, abs, isDir) {
  let ignored = false;
  for (const { base, ig } of matchers) {
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    const t = ig.test(isDir ? `${rel}/` : rel);
    if (t.ignored) ignored = true;
    else if (t.unignored) ignored = false;
  }
  return ignored;
}

const wantsGitignore = (v) => v !== '0' && v !== false && v !== 0;

/** One directory entry, following symlinks so a link to a folder opens as a folder. */
async function describe(dir, name) {
  const abs = path.join(dir, name);
  let lst;
  try {
    lst = await fsp.lstat(abs);
  } catch {
    return null;
  }
  let st = lst;
  let broken = false;
  if (lst.isSymbolicLink()) {
    try {
      st = await fsp.stat(abs);
    } catch {
      broken = true;
    }
  }
  return {
    name,
    type: !broken && st.isDirectory() ? 'dir' : 'file',
    link: lst.isSymbolicLink() || undefined,
    broken: broken || undefined,
    size: !broken && st.isFile() ? st.size : null,
    mtime: st.mtimeMs,
    ext: !broken && st.isDirectory() ? '' : extOf(name),
  };
}

// ── Operations ───────────────────────────────────────────────────────────

async function list(q) {
  const root = requireRoot(q.get('root'));
  const abs = inside(root, q.get('path') || '');
  let names;
  try {
    names = await fsp.readdir(abs);
  } catch (err) {
    throw fsError(err);
  }
  let entries = (await Promise.all(names.map((n) => describe(abs, n)))).filter(Boolean);
  let ignored = 0;
  if (wantsGitignore(q.get('gitignore'))) {
    const matchers = await matchersFor(root, abs);
    if (matchers.length) {
      const kept = entries.filter((e) => !isIgnored(matchers, path.join(abs, e.name), e.type === 'dir'));
      ignored = entries.length - kept.length;
      entries = kept;
    }
  }
  return { path: relOf(root, abs), entries, ignored };
}

/** Breadth-first name search under `path`, bounded by result count, time and visited entries. */
async function search(q) {
  const root = requireRoot(q.get('root'));
  const start = inside(root, q.get('path') || '');
  const terms = String(q.get('q') || '').toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  if (!terms.length) throw new HttpError(400, 'Пустой запрос.');
  const limit = Math.min(Math.max(Number(q.get('limit')) || SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const showHidden = q.get('hidden') === '1';
  const useGitignore = wantsGitignore(q.get('gitignore'));
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  const seen = new Set();
  // A queued folder carries its ancestors' matchers; its own .gitignore is added on visit.
  const startMatchers = useGitignore && start !== root ? await matchersFor(root, path.dirname(start)) : [];
  const queue = [{ dir: start, matchers: startMatchers }];
  const results = [];
  let visited = 0;
  let incomplete = false;

  while (queue.length) {
    if (results.length >= limit || Date.now() > deadline || visited > SEARCH_MAX_VISITED) {
      incomplete = true;
      break;
    }
    const { dir, matchers: parentMatchers } = queue.shift();
    const matchers = useGitignore ? await withOwnMatcher(parentMatchers, dir) : parentMatchers;
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue; // symlink loops
    seen.add(real);
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      visited++;
      if (!showHidden && d.name.startsWith('.')) continue;
      const abs = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(abs)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      // An ignored folder is skipped whole, like git does: nothing under it is searched.
      if (matchers.length && isIgnored(matchers, abs, isDir)) continue;
      const lower = d.name.toLocaleLowerCase('ru');
      if (terms.every((t) => lower.includes(t))) {
        const item = await describe(dir, d.name);
        if (item) results.push({ ...item, path: relOf(root, abs) });
        if (results.length >= limit) break;
      }
      if (isDir && !SKIP_IN_SEARCH.has(d.name)) queue.push({ dir: abs, matchers });
    }
  }
  return { results, incomplete, visited };
}

async function sendRaw(q, res) {
  const root = requireRoot(q.get('root'));
  const abs = inside(root, q.get('path') || '');
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    throw fsError(err);
  }
  if (!st.isFile()) throw new HttpError(400, 'Это не файл.');
  const name = path.basename(abs);
  res.writeHead(200, {
    'Content-Type': MIME[extOf(name)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(abs);
    stream.on('error', reject);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

async function mkdir(b) {
  const root = requireRoot(b.root);
  const abs = inside(root, path.posix.join(b.path || '', validName(b.name)));
  try {
    await fsp.mkdir(abs);
  } catch (err) {
    throw fsError(err);
  }
  return { ok: true, path: relOf(root, abs) };
}

async function rename(b) {
  const root = requireRoot(b.root);
  const from = inside(root, b.path);
  if (from === root) throw new HttpError(400, 'Нельзя переименовать корень проекта.');
  const to = path.join(path.dirname(from), validName(b.newName));
  inside(root, relOf(root, to));
  try {
    await fsp.access(to);
    throw new HttpError(409, 'Файл или папка с таким именем уже есть.');
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  try {
    await fsp.rename(from, to);
  } catch (err) {
    throw fsError(err);
  }
  return { ok: true, path: relOf(root, to) };
}

async function remove(b) {
  const root = requireRoot(b.root);
  const abs = inside(root, b.path);
  if (abs === root) throw new HttpError(400, 'Нельзя удалить корень проекта.');
  try {
    const lst = await fsp.lstat(abs);
    // A symlink is removed itself, never the folder it points to.
    if (lst.isDirectory() && !lst.isSymbolicLink()) await fsp.rm(abs, { recursive: true });
    else await fsp.unlink(abs);
  } catch (err) {
    throw fsError(err);
  }
  return { ok: true };
}

// Chunked upload: the host proxy only forwards JSON, so the browser sends base64
// chunks in order. Chunks go to a hidden temp file that is renamed into place on
// the last chunk, so a half-uploaded file never appears under its real name.
const uploads = new Map();

function sweepUploads() {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.touched > UPLOAD_TTL_MS) {
      fsp.unlink(u.tmp).catch(() => {});
      uploads.delete(id);
    }
  }
}

async function upload(b) {
  sweepUploads();
  const root = requireRoot(b.root);
  let u;
  if (!b.id) {
    const dir = inside(root, b.path || '');
    const name = validName(b.name);
    const target = path.join(dir, name);
    if (!b.overwrite) {
      try {
        await fsp.access(target);
        throw new HttpError(409, `Файл «${name}» уже есть в этой папке.`);
      } catch (err) {
        if (err instanceof HttpError) throw err;
      }
    }
    const id = crypto.randomUUID();
    u = { tmp: path.join(dir, `.${name}.uploading-${id.slice(0, 8)}`), target, received: 0, touched: Date.now() };
    try {
      await fsp.writeFile(u.tmp, '');
    } catch (err) {
      throw fsError(err);
    }
    uploads.set(id, u);
    b.id = id;
  } else {
    u = uploads.get(b.id);
    if (!u) throw new HttpError(410, 'Загрузка прервана, начните заново.');
  }
  if (Number(b.offset) !== u.received) throw new HttpError(409, 'Части файла пришли не по порядку.');
  const chunk = Buffer.from(String(b.data || ''), 'base64');
  try {
    await fsp.appendFile(u.tmp, chunk);
    u.received += chunk.length;
    u.touched = Date.now();
    if (b.final) {
      await fsp.rename(u.tmp, u.target);
      uploads.delete(b.id);
      return { ok: true, id: b.id, received: u.received, path: relOf(root, u.target) };
    }
  } catch (err) {
    await fsp.unlink(u.tmp).catch(() => {});
    uploads.delete(b.id);
    throw fsError(err);
  }
  return { ok: true, id: b.id, received: u.received };
}

async function cancelUpload(b) {
  const u = uploads.get(b.id);
  if (u) {
    uploads.delete(b.id);
    await fsp.unlink(u.tmp).catch(() => {});
  }
  return { ok: true };
}

// ── HTTP wiring ──────────────────────────────────────────────────────────

const GET = { '/list': list, '/search': search };
const POST = { '/mkdir': mkdir, '/rename': rename, '/delete': remove, '/upload': upload, '/upload-cancel': cancelUpload };

function readJson(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/raw') {
      await sendRaw(url.searchParams, res);
      return;
    }
    const handler = req.method === 'GET' ? GET[url.pathname] : req.method === 'POST' ? POST[url.pathname] : undefined;
    if (!handler) throw new HttpError(404, 'Неизвестный запрос.');
    const result = await handler(req.method === 'GET' ? url.searchParams : await readJson(req));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const e = err instanceof HttpError ? err : fsError(err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(e.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  // The host waits for this exact JSON line before proxying requests.
  if (addr && typeof addr !== 'string') console.log(JSON.stringify({ ready: true, port: addr.port }));
});

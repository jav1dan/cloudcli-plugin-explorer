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
import zlib from 'node:zlib';
import { pipeline, Transform } from 'node:stream';
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
  const disposition = q.get('download') === '1' ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': MIME[extOf(name)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
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

// ── ZIP download ─────────────────────────────────────────────────────────
// A folder is streamed as a ZIP while it is read, so nothing is buffered or
// written to disk. Sizes are unknown up front, so each file is followed by a data
// descriptor. ZIP64 fields are used only where a value overflows 32 (or 16) bits,
// which keeps small archives readable everywhere. Names are UTF-8 (flag bit 11).

const ZIP64_LIMIT = Number(process.env.EXPLORER_ZIP64_LIMIT) || 0xffffffff;
const ZIP64_COUNT_LIMIT = Number(process.env.EXPLORER_ZIP64_COUNT_LIMIT) || 0xffff;
// Formats that are already compressed: deflating them again only burns CPU.
const ZIP_STORE = new Set(['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'pdf',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'mp3', 'mp4', 'mov', 'webm', 'avi', 'mkv', 'ogg']);

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Yields what the folder view shows: entries in name order, honouring hidden and .gitignore. */
async function* zipEntries(dir, prefix, matchers, opts, seen) {
  let real;
  try {
    real = await fsp.realpath(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return; // symlink loop
  seen.add(real);
  const own = opts.gitignore ? await withOwnMatcher(matchers, dir) : matchers;
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    if (!opts.hidden && d.name.startsWith('.')) continue;
    if (SKIP_IN_SEARCH.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      continue; // broken link or vanished
    }
    const isDir = st.isDirectory();
    if (own.length && isIgnored(own, abs, isDir)) continue;
    if (isDir) {
      yield { dir: true, name: `${prefix}${d.name}/`, mtime: st.mtimeMs };
      yield* zipEntries(abs, `${prefix}${d.name}/`, own, opts, seen);
    } else if (st.isFile()) {
      yield { dir: false, abs, name: `${prefix}${d.name}`, size: st.size, mtime: st.mtimeMs };
    }
  }
}

async function sendZip(q, res) {
  const root = requireRoot(q.get('root'));
  const abs = inside(root, q.get('path') || '');
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    throw fsError(err);
  }
  if (!st.isDirectory()) throw new HttpError(400, 'Это не папка.');
  const base = path.basename(abs) || 'project';
  const opts = { gitignore: wantsGitignore(q.get('gitignore')), hidden: q.get('hidden') === '1' };
  const matchers = opts.gitignore && abs !== root ? await matchersFor(root, path.dirname(abs)) : [];

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });

  let offset = 0;
  const central = [];
  const write = (buf) => new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('client went away'));
    offset += buf.length;
    if (res.write(buf)) return resolve();
    const done = () => {
      res.off('close', gone);
      resolve();
    };
    const gone = () => {
      res.off('drain', done);
      reject(new Error('client went away'));
    };
    res.once('drain', done);
    res.once('close', gone);
  });

  const addCentral = (e) => {
    const big = e.csize >= ZIP64_LIMIT || e.usize >= ZIP64_LIMIT || e.offset >= ZIP64_LIMIT;
    const extra = [];
    if (e.usize >= ZIP64_LIMIT) extra.push(e.usize);
    if (e.csize >= ZIP64_LIMIT) extra.push(e.csize);
    if (e.offset >= ZIP64_LIMIT) extra.push(e.offset);
    const ex = Buffer.alloc(extra.length ? 4 + extra.length * 8 : 0);
    if (extra.length) {
      ex.writeUInt16LE(0x0001, 0);
      ex.writeUInt16LE(extra.length * 8, 2);
      extra.forEach((v, i) => ex.writeBigUInt64LE(BigInt(v), 4 + i * 8));
    }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    // Made by Unix: Info-ZIP unzip re-encodes MS-DOS-made names from the OEM code
    // page despite the UTF-8 flag. Windows Explorer goes by the flag either way.
    h.writeUInt16LE((3 << 8) | (big ? 45 : 30), 4); // made by
    h.writeUInt16LE(big ? 45 : 20, 6); // needed
    h.writeUInt16LE(e.flags, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc >>> 0, 16);
    h.writeUInt32LE(e.csize >= ZIP64_LIMIT ? 0xffffffff : e.csize, 20);
    h.writeUInt32LE(e.usize >= ZIP64_LIMIT ? 0xffffffff : e.usize, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(ex.length, 30);
    h.writeUInt32LE(((e.dir ? 0o40775 : 0o100664) << 16 | (e.dir ? 0x10 : 0)) >>> 0, 38); // Unix mode + DOS dir bit
    h.writeUInt32LE(e.offset >= ZIP64_LIMIT ? 0xffffffff : e.offset, 42);
    central.push(Buffer.concat([h, e.nameBuf, ex]));
  };

  try {
    const root0 = { dir: true, name: `${base}/`, mtime: st.mtimeMs };
    const all = (async function* () {
      yield root0;
      yield* zipEntries(abs, `${base}/`, matchers, opts, new Set());
    })();
    for await (const item of all) {
      const nameBuf = Buffer.from(item.name, 'utf8');
      const { time, date } = dosDateTime(item.mtime);
      const localOffset = offset;
      if (item.dir) {
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0x0800, 6);
        h.writeUInt16LE(0, 8);
        h.writeUInt16LE(time, 10);
        h.writeUInt16LE(date, 12);
        h.writeUInt16LE(nameBuf.length, 26);
        await write(Buffer.concat([h, nameBuf]));
        addCentral({ dir: true, flags: 0x0800, method: 0, time, date, crc: 0, csize: 0, usize: 0, offset: localOffset, nameBuf });
        continue;
      }
      const deflate = item.size > 0 && !ZIP_STORE.has(extOf(item.name));
      // Only the size known now decides ZIP64 here; a file growing past 4 GB while
      // being read is not supported.
      const z64 = item.size >= ZIP64_LIMIT - 0x100000;
      const ex = Buffer.alloc(z64 ? 20 : 0);
      if (z64) {
        ex.writeUInt16LE(0x0001, 0);
        ex.writeUInt16LE(16, 2); // sizes stay 0 here; the data descriptor carries them
      }
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(z64 ? 45 : 20, 4);
      h.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8
      h.writeUInt16LE(deflate ? 8 : 0, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      if (z64) {
        h.writeUInt32LE(0xffffffff, 18);
        h.writeUInt32LE(0xffffffff, 22);
      }
      h.writeUInt16LE(nameBuf.length, 26);
      h.writeUInt16LE(ex.length, 28);
      await write(Buffer.concat([h, nameBuf, ex]));

      let crc = 0;
      let usize = 0;
      let csize = 0;
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          crc = zlib.crc32(chunk, crc);
          usize += chunk.length;
          cb(null, chunk);
        },
      });
      const parts = [fs.createReadStream(item.abs), tap];
      if (deflate) parts.push(zlib.createDeflateRaw({ level: 6 }));
      const out = pipeline(...parts, () => {});
      for await (const chunk of out) {
        csize += chunk.length;
        await write(chunk);
      }
      const dd = Buffer.alloc(z64 ? 24 : 16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc >>> 0, 4);
      if (z64) {
        dd.writeBigUInt64LE(BigInt(csize), 8);
        dd.writeBigUInt64LE(BigInt(usize), 16);
      } else {
        dd.writeUInt32LE(csize, 8);
        dd.writeUInt32LE(usize, 12);
      }
      await write(dd);
      addCentral({ dir: false, flags: 0x0808, method: deflate ? 8 : 0, time, date, crc, csize, usize, offset: localOffset, nameBuf });
    }

    const cdStart = offset;
    for (const c of central) await write(c);
    const cdSize = offset - cdStart;
    const count = central.length;
    const need64 = count >= ZIP64_COUNT_LIMIT || cdStart >= ZIP64_LIMIT || cdSize >= ZIP64_LIMIT;
    if (need64) {
      const eocd64At = offset;
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(eocd64At), 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([z, loc]));
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(need64 ? 0xffff : count, 8);
    e.writeUInt16LE(need64 ? 0xffff : count, 10);
    e.writeUInt32LE(need64 ? 0xffffffff : cdSize, 12);
    e.writeUInt32LE(need64 ? 0xffffffff : cdStart, 16);
    await write(e);
    res.end();
  } catch {
    // Headers are gone already: the only honest signal left is a broken download.
    res.destroy();
  }
}

// ── Copy / move ──────────────────────────────────────────────────────────
// Large copies outlive the ~100 s a proxy such as Cloudflare waits for a response,
// so they run as jobs: POST /transfer starts one, GET /job reports progress.

const JOB_TTL_MS = 10 * 60_000;
const jobs = new Map();

function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finished && now - j.finished > JOB_TTL_MS) jobs.delete(id);
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** "name (2).ext", "name (3).ext", … — the first one not taken in `dir`. */
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new HttpError(409, 'Не удалось подобрать свободное имя.');
}

async function countFiles(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return 1;
  let n = 1;
  for (const name of await fsp.readdir(p)) n += await countFiles(path.join(p, name));
  return n;
}

/** Copies a file, symlink or whole folder; symlinks are copied as links, not followed. */
async function copyTree(src, dst, job, overwrite) {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    if (overwrite) await fsp.rm(dst, { force: true });
    await fsp.symlink(await fsp.readlink(src), dst);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dst);
    for (const name of await fsp.readdir(src)) await copyTree(path.join(src, name), path.join(dst, name), job, false);
    await fsp.utimes(dst, st.atime, st.mtime).catch(() => {});
  } else {
    await fsp.copyFile(src, dst, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    await fsp.utimes(dst, st.atime, st.mtime).catch(() => {});
  }
  job.done++;
}

async function runTransfer(job, src, target, op, overwrite) {
  try {
    if (op === 'move') {
      try {
        await fsp.rename(src, target);
        job.done = job.total;
        return;
      } catch (err) {
        // A move across mount points (bind mounts included) cannot be a rename.
        if (err.code !== 'EXDEV') throw err;
      }
    }
    job.total = await countFiles(src);
    await copyTree(src, target, job, overwrite);
    if (op === 'move') {
      job.phase = 'cleanup';
      await fsp.rm(src, { recursive: true, force: true });
    }
  } catch (err) {
    job.error = fsError(err).message;
  } finally {
    job.status = job.error ? 'error' : 'done';
    job.finished = Date.now();
  }
}

async function transfer(b) {
  sweepJobs();
  const root = requireRoot(b.root);
  const op = b.op === 'move' ? 'move' : b.op === 'copy' ? 'copy' : null;
  if (!op) throw new HttpError(400, 'Неизвестная операция.');
  const src = inside(root, b.path);
  if (src === root) throw new HttpError(400, 'Нельзя переносить или копировать корень проекта.');
  const destDir = inside(root, b.dest || '');
  let srcSt;
  let destSt;
  try {
    srcSt = await fsp.lstat(src);
    destSt = await fsp.stat(destDir);
  } catch (err) {
    throw fsError(err);
  }
  if (!destSt.isDirectory()) throw new HttpError(400, 'Папка назначения — не папка.');
  const srcIsDir = srcSt.isDirectory();
  if (srcIsDir && (destDir === src || destDir.startsWith(src + path.sep))) {
    throw new HttpError(400, 'Нельзя положить папку внутрь неё самой.');
  }
  let name = path.basename(src);
  let target = path.join(destDir, name);
  if (op === 'move' && target === src) throw new HttpError(400, 'Уже лежит в этой папке.');
  let overwrite = false;
  if (await exists(target)) {
    const conflict = b.conflict || (op === 'copy' && target === src ? 'rename' : 'fail');
    if (conflict === 'rename') {
      name = await freeName(destDir, name);
      target = path.join(destDir, name);
    } else if (conflict === 'replace') {
      const tSt = await fsp.lstat(target);
      if (srcIsDir || tSt.isDirectory()) throw new HttpError(400, 'Заменять можно только файл файлом.');
      overwrite = true;
    } else {
      const e = new HttpError(409, `В папке назначения уже есть «${name}».`);
      e.extra = { conflict: true, canReplace: !srcIsDir && !(await fsp.lstat(target)).isDirectory() };
      throw e;
    }
  }
  const id = crypto.randomUUID();
  const job = { id, op, name, status: 'running', phase: op, done: 0, total: 1, error: null, finished: 0, path: relOf(root, target) };
  jobs.set(id, job);
  runTransfer(job, src, target, op, overwrite);
  return { id };
}

async function jobStatus(q) {
  const job = jobs.get(String(q.get('id') || ''));
  if (!job) throw new HttpError(404, 'Задача не найдена.');
  const { id, op, name, status, phase, done, total, error, path: target } = job;
  return { id, op, name, status, phase, done, total, error, path: target };
}

// ── HTTP wiring ──────────────────────────────────────────────────────────

const GET = { '/list': list, '/search': search, '/job': jobStatus };
const POST = {
  '/mkdir': mkdir, '/rename': rename, '/delete': remove, '/upload': upload, '/upload-cancel': cancelUpload, '/transfer': transfer,
};

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
    if (req.method === 'GET' && url.pathname === '/zip') {
      await sendZip(url.searchParams, res);
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
    res.end(JSON.stringify({ error: e.message, ...(err.extra || {}) }));
  }
});

// The host reaches this server through Node's keep-alive agent, which drops idle
// sockets after 5 s, the same as this server's default. With equal timeouts the host
// can reuse a socket at the moment this side closes it ("socket hang up" / 500).
// Outlasting the agent means the host side always closes first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  // The host waits for this exact JSON line before proxying requests.
  if (addr && typeof addr !== 'string') console.log(JSON.stringify({ ready: true, port: addr.port }));
});

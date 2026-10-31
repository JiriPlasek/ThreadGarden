/**
 * Project icons (v1.3 §5): the favicon or logo a project already has, found in
 * the project folder (the user's own working directory, never the Claude
 * config dir) and answered as a `data:` URL.
 *
 * The search order is the spec's: icons linked from an HTML entry file
 * (`index.html`, `public/index.html`, `src/index.html`, `src/app.html`), then
 * fixed paths (`FIXED`), then the same fixed paths one level into `apps/*` and
 * `packages/*`. Only regular files whose real path stays inside the project's
 * real path (no symlink escape), at most `MAX_ICON_BYTES`, with an allowed
 * image extension and matching magic bytes are used.
 *
 * Everything is async and every file-system call counts against a budget
 * (`DEFAULT_MAX_OPS`), so a huge or slow folder costs a bounded number of
 * libuv threadpool calls and never blocks the event loop. Directory listings
 * decide which paths exist, so a path is only stat'ed when it is there.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Largest icon file used (bytes). */
export const MAX_ICON_BYTES = 512 * 1024;
/** A cached answer is searched again after this long (10 minutes). */
export const ICON_RECHECK_MS = 10 * 60_000;
/** File-system calls one search may make. */
export const DEFAULT_MAX_OPS = 200;
/** Searches running at once (each makes threadpool calls, like `FolderCheck`). */
export const MAX_ICON_SEARCHES = 2;
/** Bytes of an HTML entry file scanned for `<link>` tags (they live in `<head>`). */
const HTML_SCAN_BYTES = 128 * 1024;
/** Cached data URLs kept at most (characters), least recently used dropped first. */
const CACHE_MAX_CHARS = 16 * 1024 * 1024;

export type IconMime =
  'image/png' | 'image/x-icon' | 'image/svg+xml' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Allowed extensions, in the order tried for a `name.*` fixed path. */
const EXTS = ['svg', 'png', 'ico', 'webp', 'gif', 'jpg', 'jpeg'] as const;
const EXT_SET = new Set<string>(EXTS);

const HTML_FILES = ['index.html', 'public/index.html', 'src/index.html', 'src/app.html'];

/** `[dir, base name, extensions]`; `null` extensions = any allowed one, in `EXTS` order. */
type Fixed = readonly [dir: string, base: string, exts: readonly string[] | null];
const FIXED: readonly Fixed[] = [
  ['', 'favicon', ['svg', 'ico', 'png']],
  ['public', 'favicon', null],
  ['static', 'favicon', null],
  ['app', 'favicon', ['ico']],
  ['app', 'icon', null],
  ['src/app', 'favicon', ['ico']],
  ['src/app', 'icon', null],
  ['assets', 'icon', null],
  ['', 'icon', ['png']],
  ['', 'logo', ['svg']],
  ['public', 'logo', null],
  ['src-tauri/icons', 'icon', ['png']],
  ['.github', 'logo', null],
];
const MONOREPO_DIRS = ['apps', 'packages'];

const startsWith = (buf: Buffer, bytes: readonly number[]): boolean =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/**
 * The image type of `buf` by its magic bytes, or null when it is not one of
 * the allowed types. SVG is text that starts (after a BOM and white space)
 * with `<svg`, or with `<?xml` and contains `<svg`.
 */
export const sniffImage = (buf: Buffer): IconMime | null => {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  const text = buf
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (text.startsWith('<svg')) return 'image/svg+xml';
  if (text.startsWith('<?xml') && text.includes('<svg')) return 'image/svg+xml';
  return null;
};

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * The hrefs of `<link rel="icon">` (also `shortcut icon`) tags in `html`, in
 * document order, then those of `apple-touch-icon` links. Comments are
 * skipped; `mask-icon` (a monochrome Safari mask) and others are not icons.
 */
export const linkIconHrefs = (html: string): string[] => {
  const icons: string[] = [];
  const touch: string[] = [];
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const [tag] of text.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const m of tag.slice(5).matchAll(ATTR)) {
      const name = m[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
    }
    const href = attrs.get('href')?.trim();
    if (!href) continue;
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('icon')) icons.push(href);
    else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
      touch.push(href);
    }
  }
  return [...icons, ...touch];
};

export type FoundIcon = {
  /** Real path of the icon file. */
  file: string;
  mtimeMs: number;
  size: number;
  dataUrl: string;
};

export type FindOptions = {
  /** File-system calls allowed (default `DEFAULT_MAX_OPS`); the search answers null past it. */
  maxOps?: number;
};

class OutOfOps extends Error {}

const extOf = (p: string): string => path.extname(p).slice(1).toLowerCase();

/** `child` is `root` itself or inside it (both real, normalised paths). */
const inside = (root: string, child: string): boolean => {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** O_NONBLOCK where it exists, so opening a FIFO swapped in after the stat cannot hang. */
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);

/** One search over one project folder. */
class Search {
  private ops: number;
  private rootReal = '';
  /** Directory (relative, `/`-separated) → its entries by lower-cased name, or null if absent. */
  private readonly listings = new Map<string, Promise<Map<string, string> | null>>();
  private readonly tried = new Set<string>();

  constructor(
    private readonly root: string,
    maxOps: number,
  ) {
    this.ops = maxOps;
  }

  private take(): void {
    if (this.ops <= 0) throw new OutOfOps();
    this.ops--;
  }

  run = async (): Promise<FoundIcon | null> => {
    try {
      this.take();
      this.rootReal = await realpath(this.root);
    } catch {
      return null; // folder gone or unreadable
    }
    try {
      return (await this.fromHtml()) ?? (await this.fromFixed('')) ?? (await this.fromMonorepo());
    } catch (err) {
      if (err instanceof OutOfOps) return null;
      throw err;
    }
  };

  /** Entries of `rel` (a directory under the root), each parent listed first so absent ones cost nothing. */
  private listing(rel: string): Promise<Map<string, string> | null> {
    let p = this.listings.get(rel);
    if (!p) {
      p = this.list(rel);
      this.listings.set(rel, p);
    }
    return p;
  }

  private async list(rel: string): Promise<Map<string, string> | null> {
    let dir = this.rootReal;
    if (rel !== '') {
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const actual = (await this.listing(parent))?.get(name.toLowerCase());
      if (actual === undefined) return null;
      dir = path.join(this.rootReal, ...(parent ? parent.split('/') : []), actual);
    }
    this.take();
    try {
      const names = await readdir(dir);
      return new Map(names.map((n) => [n.toLowerCase(), n]));
    } catch {
      return null;
    }
  }

  /** The actual path of `rel` (`/`-separated, under the root) when its directory lists it. */
  private async existing(rel: string): Promise<string | null> {
    const parts = rel.split('/').filter((s) => s !== '' && s !== '.');
    if (parts.length === 0 || parts.some((s) => s === '..')) return null;
    const name = parts.pop()!;
    const dir = parts.join('/');
    // Every parent must be listed (and so exist) before the name is looked up.
    const actual = (await this.listing(dir))?.get(name.toLowerCase());
    if (actual === undefined) return null;
    const segments: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      segments.push((await this.listing(sub))?.get(parts[i]!.toLowerCase()) ?? parts[i]!);
    }
    return path.join(this.rootReal, ...segments, actual);
  }

  /** Validates and reads one candidate; null when it is not a usable icon. */
  private async load(file: string): Promise<FoundIcon | null> {
    if (!EXT_SET.has(extOf(file))) return null;
    let real: string;
    try {
      this.take();
      real = await realpath(file);
    } catch (err) {
      if (err instanceof OutOfOps) throw err;
      return null;
    }
    if (this.tried.has(real)) return null;
    this.tried.add(real);
    if (!inside(this.rootReal, real) || !EXT_SET.has(extOf(real))) return null;
    this.take();
    const st = await stat(real).catch(() => null);
    if (!st?.isFile() || st.size === 0 || st.size > MAX_ICON_BYTES) return null;
    this.take();
    const fh = await open(real, READ_FLAGS).catch(() => null);
    if (!fh) return null;
    let buf: Buffer;
    try {
      // Re-checked on the open handle: the file may have changed since the stat.
      const fst = await fh.stat();
      if (!fst.isFile() || fst.size === 0 || fst.size > MAX_ICON_BYTES) return null;
      const out = Buffer.alloc(MAX_ICON_BYTES + 1);
      let n = 0;
      for (;;) {
        const { bytesRead } = await fh.read(out, n, out.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n > MAX_ICON_BYTES) return null;
      }
      buf = out.subarray(0, n);
    } catch {
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
    const mime = sniffImage(buf);
    if (!mime) return null;
    // SVG is text: only trusted from a .svg file, and a .svg must be SVG.
    if ((mime === 'image/svg+xml') !== (extOf(real) === 'svg')) return null;
    return {
      file: real,
      mtimeMs: st.mtimeMs,
      size: buf.length,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  }

  private async firstOf(rels: readonly string[]): Promise<FoundIcon | null> {
    for (const rel of rels) {
      const file = await this.existing(rel);
      if (!file) continue;
      const icon = await this.load(file);
      if (icon) return icon;
    }
    return null;
  }

  /** The start of `file` (an HTML entry), or null. */
  private async readHtml(file: string): Promise<string | null> {
    this.take();
    const fh = await open(file, READ_FLAGS).catch(() => null);
    if (!fh) return null;
    try {
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const buf = Buffer.alloc(Math.min(HTML_SCAN_BYTES, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  private async fromHtml(): Promise<FoundIcon | null> {
    for (const htmlRel of HTML_FILES) {
      const file = await this.existing(htmlRel);
      if (!file) continue;
      let real: string;
      try {
        this.take();
        real = await realpath(file);
      } catch (err) {
        if (err instanceof OutOfOps) throw err;
        continue;
      }
      if (!inside(this.rootReal, real)) continue;
      const html = await this.readHtml(real);
      if (html === null) continue;
      const htmlDir = path.posix.dirname(htmlRel) === '.' ? '' : path.posix.dirname(htmlRel);
      for (const href of linkIconHrefs(html)) {
        const icon = await this.firstOf(candidatesFor(href, htmlDir));
        if (icon) return icon;
      }
    }
    return null;
  }

  private fromFixed(base: string): Promise<FoundIcon | null> {
    const prefix = base === '' ? '' : `${base}/`;
    const rels: string[] = [];
    for (const [dir, name, exts] of FIXED) {
      const d = dir === '' ? prefix : `${prefix}${dir}/`;
      for (const ext of exts ?? EXTS) rels.push(`${d}${name}.${ext}`);
    }
    return this.firstOf(rels);
  }

  private async fromMonorepo(): Promise<FoundIcon | null> {
    for (const container of MONOREPO_DIRS) {
      const entries = await this.listing(container);
      if (!entries) continue;
      const names = [...entries.values()].sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const icon = await this.fromFixed(`${container}/${name}`);
        if (icon) return icon;
      }
    }
    return null;
  }
}

/**
 * Project-relative paths (`/`-separated) an icon `href` may point to, in the
 * order tried: relative to the HTML file's directory, then to `public/` and
 * `static/` (where Vite, SvelteKit and Create React App serve `/…` from),
 * then the project root. Remote, protocol-relative and `data:` URLs give none.
 */
const candidatesFor = (href: string, htmlDir: string): string[] => {
  let h = href.replace(/%sveltekit\.assets%/g, '').replace(/%PUBLIC_URL%/g, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('\\\\')) return [];
  h = h.replace(/[?#].*$/, '').replace(/\\/g, '/');
  try {
    h = decodeURIComponent(h);
  } catch {
    // keep it as written
  }
  if (h.trim() === '' || h.includes('\0')) return [];
  const rooted = h.startsWith('/');
  const rel = h.replace(/^\/+/, '');
  const bases = rooted ? ['public', 'static', htmlDir, ''] : [htmlDir, 'public', 'static'];
  const out: string[] = [];
  for (const base of bases) {
    const joined = path.posix.normalize(base === '' ? rel : `${base}/${rel}`);
    if (joined.startsWith('..') || path.posix.isAbsolute(joined)) continue;
    if (!out.includes(joined)) out.push(joined);
  }
  return out;
};

/** Finds the icon of the project folder `root` (see the module comment); null when it has none. */
export const findProjectIcon = (root: string, o: FindOptions = {}): Promise<FoundIcon | null> =>
  new Search(root, o.maxOps ?? DEFAULT_MAX_OPS).run();

export type ProjectIconsOptions = {
  now?: () => number;
  /** Default `findProjectIcon`. */
  find?: (root: string) => Promise<FoundIcon | null>;
  /** Default `MAX_ICON_SEARCHES`. */
  maxConcurrent?: number;
  onError?: (err: unknown, context: string) => void;
};

type Entry = { root: string; icon: FoundIcon | null; checkedAt: number };

/**
 * Per-project cache of `findProjectIcon`. An answer younger than
 * `ICON_RECHECK_MS` stands while its file keeps its size and mtime (one
 * `stat` per request); otherwise the project is searched again. Requests for
 * a project already being looked up join that lookup, and at most
 * `maxConcurrent` lookups run at once.
 */
export class ProjectIcons {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private cachedChars = 0;
  private readonly now: () => number;
  private readonly find: (root: string) => Promise<FoundIcon | null>;
  private readonly maxConcurrent: number;

  constructor(private readonly o: ProjectIconsOptions = {}) {
    this.now = o.now ?? Date.now;
    this.find = o.find ?? ((root) => findProjectIcon(root));
    this.maxConcurrent = Math.max(1, o.maxConcurrent ?? MAX_ICON_SEARCHES);
  }

  /** The icon of project `projectId` (folder `root`) as a data URL, or null. Never rejects. */
  get(projectId: string, root: string): Promise<string | null> {
    const joined = this.inflight.get(projectId);
    if (joined) return joined;
    const p = this.slot(() => this.lookup(projectId, root))
      .catch((err: unknown) => {
        this.o.onError?.(err, `project icon ${root}`);
        return null;
      })
      .finally(() => this.inflight.delete(projectId));
    this.inflight.set(projectId, p);
    return p;
  }

  private async lookup(projectId: string, root: string): Promise<string | null> {
    const c = this.cache.get(projectId);
    if (c && c.root === root && this.now() - c.checkedAt < ICON_RECHECK_MS) {
      if (!c.icon) return null;
      const st = await stat(c.icon.file).catch(() => null);
      if (st && st.isFile() && st.mtimeMs === c.icon.mtimeMs && st.size === c.icon.size) {
        // Most recently used last, for the size cap.
        this.cache.delete(projectId);
        this.cache.set(projectId, c);
        return c.icon.dataUrl;
      }
    }
    const icon = await this.find(root);
    this.store(projectId, { root, icon, checkedAt: this.now() });
    return icon?.dataUrl ?? null;
  }

  private store(projectId: string, e: Entry): void {
    const old = this.cache.get(projectId);
    if (old) {
      this.cachedChars -= old.icon?.dataUrl.length ?? 0;
      this.cache.delete(projectId);
    }
    this.cache.set(projectId, e);
    this.cachedChars += e.icon?.dataUrl.length ?? 0;
    for (const [id, x] of this.cache) {
      if (this.cachedChars <= CACHE_MAX_CHARS || id === projectId) break;
      this.cachedChars -= x.icon?.dataUrl.length ?? 0;
      this.cache.delete(id);
    }
  }

  /** Runs `fn` once fewer than `maxConcurrent` lookups are running. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    // A finished lookup hands its slot straight to the next queued one.
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
}

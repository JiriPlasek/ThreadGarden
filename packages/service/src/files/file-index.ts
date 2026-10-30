/**
 * Project file index behind `@` mentions (spec §6.4).
 *
 * Listing: `git ls-files --cached --others --exclude-standard` inside a git
 * repo, else a walk (`fdir`) that honours `.gitignore` files: the root one
 * prunes directories during the walk, and every `.gitignore` found (root and
 * nested) is applied to the files beneath its own directory, deeper rules
 * overriding shallower ones. Unsupported: `.git/info/exclude`, global
 * excludes, and ignored directories that a nested `.gitignore` tries to
 * re-include. `.git` and `node_modules` are always skipped. Never writes to
 * the project.
 *
 * Freshness (Ruling R2): 30 s TTL plus explicit `invalidate(cwd)`; no watching.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fdir } from 'fdir';
import fuzzysort from 'fuzzysort';
import ignore, { type Ignore } from 'ignore';

export type FileSuggestion = { path: string; kind: 'file' | 'dir' };

/** Lists files (not dirs) relative to `cwd`, forward slashes; null when `cwd` is unusable. */
export type Lister = (cwd: string) => Promise<string[] | null>;

export type FileIndexOptions = {
  lister?: Lister;
  now?: () => number;
  ttlMs?: number;
  maxCwds?: number;
  /** Global budget of entries across all cached cwds (LRU eviction). */
  maxTotalEntries?: number;
};

export const MAX_ENTRIES = 200_000;
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

/** Slim per-entry record: `lower`/`nameAt`/`mask` make the ranking pass allocation-free. */
type Entry = { path: string; dir: boolean; lower: string; nameAt: number; mask: number };
type Listing = { at: number; entries: Entry[]; browse: FileSuggestion[] };

/** Normalises a cwd into a cache key (Windows: drive-letter case, separators, trailing separator). */
export const cacheKey = (cwd: string, platform: string = process.platform): string => {
  if (platform !== 'win32') return cwd;
  let k = cwd.replaceAll('/', '\\');
  if (k.length > 3) k = k.replace(/\\+$/, '');
  return k.replace(/^[a-z]:/i, (d) => d.toLowerCase());
};

const gitList = (cwd: string): Promise<string[] | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, timeout: 5000, maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(
          stdout
            .split('\0')
            .filter((p) => p.length > 0)
            .slice(0, MAX_ENTRIES),
        );
      },
    );
  });

const walkList = async (cwd: string): Promise<string[]> => {
  const rootIg = ignore();
  try {
    rootIg.add(await readFile(path.join(cwd, '.gitignore'), 'utf8'));
  } catch {
    // no root .gitignore
  }
  const rel = (p: string): string => path.relative(cwd, p).split(path.sep).join('/');
  const all = await new fdir()
    .withFullPaths()
    .withMaxFiles(MAX_ENTRIES)
    .exclude((name, dirPath) => {
      if (ALWAYS_SKIP.has(name)) return true;
      const r = rel(dirPath);
      return r !== '' && rootIg.ignores(`${r}/`);
    })
    .crawl(cwd)
    .withPromise();

  const files = all.map(rel);
  const byDir = new Map<string, Ignore>();
  for (const f of files) {
    if (f !== '.gitignore' && !f.endsWith('/.gitignore')) continue;
    try {
      const dir = f === '.gitignore' ? '' : f.slice(0, -'/.gitignore'.length);
      byDir.set(dir, ignore().add(await readFile(path.join(cwd, ...f.split('/')), 'utf8')));
    } catch {
      // unreadable .gitignore: skip it
    }
  }
  if (byDir.size === 0) return files;
  return files.filter((f) => {
    // Ancestor dirs from the root down; a deeper verdict overrides a shallower one.
    let ignored = false;
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) {
      const ig = byDir.get(parts.slice(0, i).join('/'));
      if (!ig) continue;
      const r = ig.test(parts.slice(i).join('/'));
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
    return !ignored;
  });
};

const defaultLister: Lister = async (cwd) => {
  try {
    if (!(await stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  return (await gitList(cwd)) ?? (await walkList(cwd));
};

const BROWSE_LIMIT = 500;
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Builds the listing in slices of ~8 ms, yielding to the event loop between
 * them so a 200k-entry build never blocks keystrokes or pings.
 */
const build = async (files: string[], at: number): Promise<Listing> => {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  // Browse list (empty query): shallow first, then by code unit; bounded top-N.
  const browse: { depth: number; path: string; dir: boolean }[] = [];
  const consider = (path: string, depth: number, dir: boolean): void => {
    const worst = browse[BROWSE_LIMIT - 1];
    if (worst && (depth > worst.depth || (depth === worst.depth && path >= worst.path))) return;
    let i = browse.length === BROWSE_LIMIT ? BROWSE_LIMIT - 1 : browse.length;
    while (i > 0) {
      const prev = browse[i - 1]!;
      if (prev.depth < depth || (prev.depth === depth && prev.path < path)) break;
      browse[i] = prev;
      i--;
    }
    browse[i] = { depth, path, dir };
  };
  const add = (path: string, depth: number, dir: boolean): void => {
    const lower = path.toLowerCase();
    entries.push({ path, dir, lower, nameAt: path.lastIndexOf('/') + 1, mask: charMask(lower) });
    consider(path, depth, dir);
  };
  let sliceStart = performance.now();
  const n = Math.min(files.length, MAX_ENTRIES);
  for (let k = 0; k < n; k++) {
    const f = files[k]!;
    let slash = f.indexOf('/');
    let depth = 1;
    while (slash >= 0) {
      const d = f.slice(0, slash);
      if (!seen.has(d)) {
        seen.add(d);
        add(d, depth, true);
      }
      depth++;
      slash = f.indexOf('/', slash + 1);
    }
    add(f, depth, false);
    if ((k & 255) === 255 && performance.now() - sliceStart > 8) {
      await yieldToLoop();
      sliceStart = performance.now();
    }
  }
  return {
    at,
    entries,
    browse: browse.map((b) => ({ path: b.path, kind: b.dir ? 'dir' : 'file' })),
  };
};

/** Bit set of (char code mod 32) present in `s`; a query char absent here cannot match. */
const charMask = (s: string): number => {
  let m = 0;
  for (let i = 0; i < s.length; i++) m |= 1 << (s.charCodeAt(i) & 31);
  return m;
};

/** Length of the leftmost greedy subsequence match of `q` in `s`, or -1. */
const subsequenceSpan = (s: string, q: string): number => {
  let first = -1;
  let at = -1;
  for (let k = 0; k < q.length; k++) {
    at = s.indexOf(q[k]!, at + 1);
    if (at < 0) return -1;
    if (k === 0) first = at;
  }
  return at - first + 1;
};

/**
 * Two tiers: (1) literal substring matches, scored by where they land (file
 * name prefix, inside the name, elsewhere in the path) then by name length, in
 * a single cheap O(n) pass; (2) if that leaves room, fuzzysort subsequence matches.
 * Keeps a 200k-entry index inside the per-keystroke budget.
 */
type Scored = { key: number; e: Entry };

/** Inserts into a list kept sorted ascending and bounded to `max`. */
const insertBounded = (list: Scored[], max: number, key: number, e: Entry): void => {
  if (list.length === max && key >= list[max - 1]!.key) return;
  let i = list.length === max ? max - 1 : list.length;
  while (i > 0 && list[i - 1]!.key > key) {
    list[i] = list[i - 1]!;
    i--;
  }
  list[i] = { key, e };
};

const toSuggestion = (e: Entry): FileSuggestion => ({ path: e.path, kind: e.dir ? 'dir' : 'file' });

const rank = (entries: Entry[], q: string, limit: number): FileSuggestion[] => {
  const literal = !/\s/.test(q);
  const ql = q.toLowerCase().replaceAll(' ', '');
  const keep = Math.max(limit * 8, 200);
  const best: Scored[] = [];
  let cands: Scored[] = [];
  let threshold = Infinity; // spans at or above this cannot enter the top `keep`
  // One pass: literal substring hits go to `best`; everything else that still
  // contains the query as a subsequence is a candidate for the fuzzy tier.
  const qMask = charMask(ql);
  for (const e of entries) {
    if ((e.mask & qMask) !== qMask) continue;
    const at = literal ? e.lower.indexOf(ql) : -1;
    if (at >= 0) {
      // Prefer an occurrence inside the basename over an earlier one in a directory.
      const inName = at >= e.nameAt ? at : e.lower.indexOf(ql, e.nameAt);
      let tier = 3; // only inside a directory segment
      if (inName >= 0) {
        tier = inName > e.nameAt ? 2 : 1; // inside the name / name prefix
        if (inName === e.nameAt) {
          const end = e.nameAt + ql.length;
          // exact basename, with or without a single extension
          if (end === e.lower.length || (e.lower[end] === '.' && e.lower.indexOf('.', end + 1) < 0))
            tier = 0;
        }
      }
      insertBounded(
        best,
        limit,
        tier * 1e6 +
          (e.dir ? 300_000 : 0) +
          Math.min(e.lower.length - e.nameAt, 255) * 1000 +
          Math.min(e.lower.length, 999),
        e,
      );
    } else if (best.length < limit) {
      const span = subsequenceSpan(e.lower, ql);
      if (span >= 0 && span < threshold) {
        cands.push({ key: span, e });
        if (cands.length >= keep * 8) {
          // Amortised top-k: sort rarely instead of insertion-shifting per entry.
          cands.sort((x, y) => x.key - y.key);
          cands = cands.slice(0, keep);
          threshold = cands[keep - 1]!.key;
        }
      }
    }
  }
  const out: FileSuggestion[] = best.map(({ e }) => toSuggestion(e));
  if (out.length < limit) {
    // fuzzysort ranks only the compact candidates, never all 200k entries.
    const hit = new Set(best.map((b) => b.e));
    cands.sort((x, y) => x.key - y.key);
    const pool = cands
      .slice(0, keep)
      .map((c) => c.e)
      .filter((e) => !hit.has(e));
    // Targets are prepared lazily, for this small pool only.
    for (const r of fuzzysort.go(q, pool, { key: 'path', limit: limit - out.length })) {
      out.push(toSuggestion(r.obj));
    }
  }
  return out;
};

export class FileIndex {
  private readonly lister: Lister;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxCwds: number;
  private readonly maxTotal: number;
  private readonly cache = new Map<string, Listing>();
  private readonly inflight = new Map<string, Promise<Listing | null>>();

  constructor(opts: FileIndexOptions = {}) {
    this.lister = opts.lister ?? defaultLister;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxCwds = opts.maxCwds ?? 20;
    this.maxTotal = opts.maxTotalEntries ?? 400_000;
  }

  invalidate(cwd: string): void {
    const key = cacheKey(cwd);
    this.cache.delete(key);
    this.inflight.delete(key);
  }

  async suggest(cwd: string, query: string, limit: number): Promise<FileSuggestion[]> {
    const listing = await this.listing(cwd);
    if (!listing || limit <= 0) return [];
    const q = query.trim();
    if (q === '') return listing.browse.slice(0, limit);
    return rank(listing.entries, q.replaceAll('\\', '/'), limit);
  }

  private async listing(cwd: string): Promise<Listing | null> {
    const key = cacheKey(cwd);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      // Stale-while-revalidate: an expired listing is served now and refreshed behind.
      if (this.now() - hit.at >= this.ttlMs) void this.refresh(cwd, key).catch(() => {});
      return hit;
    }
    return this.refresh(cwd, key);
  }

  private refresh(cwd: string, key: string): Promise<Listing | null> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const slot: { p?: Promise<Listing | null> } = {}; // the body reads it only after an await
    const p = (slot.p = (async () => {
      try {
        const files = await this.lister(cwd);
        if (!files) {
          if (this.inflight.get(key) === slot.p) this.cache.delete(key); // cwd vanished
          return null;
        }
        const l = await build(files, this.now());
        if (this.inflight.get(key) === slot.p) this.store(key, l);
        return l;
      } finally {
        if (this.inflight.get(key) === slot.p) this.inflight.delete(key);
      }
    })());
    this.inflight.set(key, p);
    return p;
  }

  /** Inserts as most-recent, then evicts least-recent cwds beyond the count and entry budgets. */
  private store(key: string, l: Listing): void {
    this.cache.delete(key);
    this.cache.set(key, l);
    let total = 0;
    for (const v of this.cache.values()) total += v.entries.length;
    for (const k of this.cache.keys()) {
      if ((this.cache.size <= this.maxCwds && total <= this.maxTotal) || this.cache.size <= 1)
        break;
      if (k === key) continue;
      total -= this.cache.get(k)!.entries.length;
      this.cache.delete(k);
    }
  }
}

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
};

export const MAX_ENTRIES = 200_000;
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

type Entry = FileSuggestion & {
  prepared: ReturnType<typeof fuzzysort.prepare>;
  lower: string;
  nameAt: number;
  mask: number;
};
type Listing = { at: number; entries: Entry[]; browse: FileSuggestion[] };

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

const build = (files: string[], at: number): Listing => {
  const seen = new Set<string>();
  const items: FileSuggestion[] = [];
  for (const f of files.slice(0, MAX_ENTRIES)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!seen.has(d)) {
        seen.add(d);
        items.push({ path: d, kind: 'dir' });
      }
    }
    items.push({ path: f, kind: 'file' });
  }
  const depth = (p: string): number => p.split('/').length;
  // Browse order (empty query): shallow first, then alphabetical.
  const browse = [...items]
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
    .slice(0, 500);
  const entries = items.map((i) => ({
    ...i,
    prepared: fuzzysort.prepare(i.path),
    lower: i.path.toLowerCase(),
    nameAt: i.path.lastIndexOf('/') + 1,
    mask: charMask(i.path.toLowerCase()),
  }));
  return { at, entries, browse };
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
      const tier = at === e.nameAt ? 0 : at > e.nameAt ? 1 : 2;
      insertBounded(
        best,
        limit,
        tier * 1e6 + (e.lower.length - e.nameAt) * 1000 + Math.min(e.lower.length, 999),
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
  const out: FileSuggestion[] = best.map(({ e }) => ({ path: e.path, kind: e.kind }));
  if (out.length < limit) {
    // fuzzysort ranks only the compact candidates, never all 200k entries.
    const hit = new Set(best.map((b) => b.e));
    cands.sort((x, y) => x.key - y.key);
    const pool = cands
      .slice(0, keep)
      .map((c) => c.e)
      .filter((e) => !hit.has(e));
    for (const r of fuzzysort.go(q, pool, { key: 'prepared', limit: limit - out.length })) {
      out.push({ path: r.obj.path, kind: r.obj.kind });
    }
  }
  return out;
};

export class FileIndex {
  private readonly lister: Lister;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxCwds: number;
  private readonly cache = new Map<string, Listing>();
  private readonly inflight = new Map<string, Promise<Listing | null>>();

  constructor(opts: FileIndexOptions = {}) {
    this.lister = opts.lister ?? defaultLister;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxCwds = opts.maxCwds ?? 20;
  }

  invalidate(cwd: string): void {
    this.cache.delete(cwd);
    this.inflight.delete(cwd);
  }

  async suggest(cwd: string, query: string, limit: number): Promise<FileSuggestion[]> {
    const listing = await this.listing(cwd);
    if (!listing || limit <= 0) return [];
    const q = query.trim();
    if (q === '') return listing.browse.slice(0, limit);
    return rank(listing.entries, q.replaceAll('\\', '/'), limit);
  }

  private async listing(cwd: string): Promise<Listing | null> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.cache.delete(cwd); // refresh LRU position
      this.cache.set(cwd, hit);
      return hit;
    }
    const pending = this.inflight.get(cwd);
    if (pending) return pending;
    const slot: { p?: Promise<Listing | null> } = {}; // the body reads it only after an await
    const p = (slot.p = (async () => {
      try {
        const files = await this.lister(cwd);
        if (!files) return null;
        const l = build(files, this.now());
        if (this.inflight.get(cwd) === slot.p) {
          this.cache.delete(cwd);
          this.cache.set(cwd, l);
          while (this.cache.size > this.maxCwds) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
          }
        }
        return l;
      } finally {
        if (this.inflight.get(cwd) === slot.p) this.inflight.delete(cwd);
      }
    })());
    this.inflight.set(cwd, p);
    return p;
  }
}

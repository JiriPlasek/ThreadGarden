import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileIndex, cacheKey } from '../../src/files/file-index.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'pahub-files-'));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, body = ''): void => {
  const p = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fixed = (list: string[]) => async () => list;

describe('FileIndex', () => {
  it('uses git ls-files inside a repo', async () => {
    const root = tmp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    put(root, '.gitignore', 'ignored.txt\n');
    put(root, 'tracked.ts');
    put(root, 'untracked.ts');
    put(root, 'ignored.txt');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: root });
    const got = await new FileIndex().suggest(root, '', 50);
    const files = got.filter((e) => e.kind === 'file').map((e) => e.path);
    expect(files).toContain('tracked.ts');
    expect(files).toContain('untracked.ts');
    expect(files).not.toContain('ignored.txt');
    expect(files).not.toContain('.git/HEAD');
  });

  it('respects .gitignore outside git', async () => {
    const root = tmp();
    put(root, '.gitignore', 'secret.txt\nbuild/\n');
    put(root, 'keep.ts');
    put(root, 'secret.txt');
    put(root, 'build/out.js');
    put(root, 'node_modules/x/index.js');
    put(root, 'sub/.gitignore', '*.log\n');
    put(root, 'sub/a.log');
    put(root, 'sub/a.ts');
    const got = (await new FileIndex().suggest(root, '', 100)).map((e) => e.path);
    expect(got).toContain('keep.ts');
    expect(got).toContain('sub/a.ts');
    expect(got).not.toContain('secret.txt');
    expect(got).not.toContain('build/out.js');
    expect(got).not.toContain('sub/a.log');
    expect(got.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('suggests files under a path containing spaces and non-ASCII', async () => {
    const root = path.join(tmp(), 'můj projekt');
    put(root, 'složka s mezerou/čtení souboru.md');
    const got = await new FileIndex().suggest(root, 'čtení', 10);
    expect(got).toEqual([{ path: 'složka s mezerou/čtení souboru.md', kind: 'file' }]);
  });

  it('returns dirs as kind dir', async () => {
    const idx = new FileIndex({ lister: fixed(['src/lib/a.ts', 'README.md']) });
    const got = await idx.suggest('/p', 'lib', 10);
    expect(got).toContainEqual({ path: 'src/lib', kind: 'dir' });
    expect(got).not.toContainEqual({ path: 'src/lib', kind: 'file' });
  });

  it("query 'sche' ranks src/lib/server/db/schema.ts first", async () => {
    const idx = new FileIndex({
      lister: fixed([
        'src/lib/server/db/index.ts',
        'src/lib/server/db/schema.ts',
        'src/lib/components/SchedulerView.svelte',
        'docs/scheme-notes.md',
        'src/lib/server/db/seed-schedule.ts',
      ]),
    });
    const got = await idx.suggest('/p', 'sche', 5);
    expect(got[0]).toEqual({ path: 'src/lib/server/db/schema.ts', kind: 'file' });
  });

  it('returns an empty list for a cwd that does not exist', async () => {
    expect(await new FileIndex().suggest(path.join(tmp(), 'nope'), 'x', 10)).toEqual([]);
  });

  it('shares one in-flight listing and caches for the TTL', async () => {
    let now = 0;
    const lister = vi.fn(async () => ['a.ts']);
    const idx = new FileIndex({ lister, now: () => now, ttlMs: 30_000 });
    await Promise.all([
      idx.suggest('/p', 'a', 5),
      idx.suggest('/p', 'a', 5),
      idx.suggest('/p', '', 5),
    ]);
    expect(lister).toHaveBeenCalledTimes(1);
    now = 29_000;
    await idx.suggest('/p', 'a', 5);
    expect(lister).toHaveBeenCalledTimes(1);
    now = 31_000;
    await idx.suggest('/p', 'a', 5);
    expect(lister).toHaveBeenCalledTimes(2);
    idx.invalidate('/p');
    await idx.suggest('/p', 'a', 5);
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it('bounds the cache to a number of cwds (LRU)', async () => {
    const lister = vi.fn(async () => ['a.ts']);
    const idx = new FileIndex({ lister, maxCwds: 2 });
    await idx.suggest('/1', '', 1);
    await idx.suggest('/2', '', 1);
    await idx.suggest('/1', '', 1); // touch /1
    await idx.suggest('/3', '', 1); // evicts /2
    expect(lister).toHaveBeenCalledTimes(3);
    await idx.suggest('/1', '', 1);
    expect(lister).toHaveBeenCalledTimes(3);
    await idx.suggest('/2', '', 1);
    expect(lister).toHaveBeenCalledTimes(4);
  });

  it('ranks a basename match above an earlier directory-segment match', async () => {
    const a = new FileIndex({
      lister: fixed(['other/xfoo.ts', 'src/foo/foo.ts', 'foo/bar/baz.ts']),
    });
    expect((await a.suggest('/p', 'foo', 5))[0]).toEqual({ path: 'src/foo/foo.ts', kind: 'file' });
    const b = new FileIndex({
      lister: fixed(['other/schemas.ts', 'schema/x/schema.ts', 'schema/x/y.ts']),
    });
    expect((await b.suggest('/p', 'schema', 5))[0]).toEqual({
      path: 'schema/x/schema.ts',
      kind: 'file',
    });
  });

  it('ranks an exact basename (with or without extension) first', async () => {
    const idx = new FileIndex({
      lister: fixed(['a/index-utils.ts', 'a/reindex.ts', 'b/deep/index.ts', 'c/index.test.ts']),
    });
    expect((await idx.suggest('/p', 'index', 5))[0]?.path).toBe('b/deep/index.ts');
    expect((await idx.suggest('/p', 'index.ts', 5))[0]?.path).toBe('b/deep/index.ts');
  });

  it('falls back to fuzzy matches when no literal match exists', async () => {
    const idx = new FileIndex({ lister: fixed(['src/lib/schema-migrations.ts', 'README.md']) });
    expect(await idx.suggest('/p', 'scmts', 5)).toEqual([
      { path: 'src/lib/schema-migrations.ts', kind: 'file' },
    ]);
  });

  it('serves an expired listing immediately and refreshes in the background', async () => {
    let now = 0;
    let files = ['old.ts'];
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const lister = vi.fn(async () => {
      await gate;
      return files;
    });
    const idx = new FileIndex({ lister, now: () => now, ttlMs: 1000 });
    expect(await idx.suggest('/p', 'ts', 5)).toEqual([{ path: 'old.ts', kind: 'file' }]);
    now = 5000;
    files = ['new.ts'];
    gate = new Promise<void>((r) => (release = r));
    // Refresh is blocked, yet the stale answer arrives right away.
    expect(await idx.suggest('/p', 'ts', 5)).toEqual([{ path: 'old.ts', kind: 'file' }]);
    expect(lister).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(async () =>
      expect(await idx.suggest('/p', 'ts', 5)).toEqual([{ path: 'new.ts', kind: 'file' }]),
    );
  });

  it('evicts least-recent cwds when the global entry budget is exceeded', async () => {
    const lister = vi.fn(async () => ['a/1.ts', 'a/2.ts']); // 3 entries (dir + 2 files)
    const idx = new FileIndex({ lister, maxTotalEntries: 7, maxCwds: 10 });
    await idx.suggest('/1', '', 1);
    await idx.suggest('/2', '', 1);
    expect(lister).toHaveBeenCalledTimes(2);
    await idx.suggest('/3', '', 1); // 9 > 7: evicts /1
    await idx.suggest('/2', '', 1);
    await idx.suggest('/3', '', 1);
    expect(lister).toHaveBeenCalledTimes(3);
    await idx.suggest('/1', '', 1);
    expect(lister).toHaveBeenCalledTimes(4);
  });

  it('normalises cache keys on win32', () => {
    expect(cacheKey('C:/Work/App/', 'win32')).toBe('c:\\Work\\App');
    expect(cacheKey('c:\\Work\\App', 'win32')).toBe('c:\\Work\\App');
    expect(cacheKey('C:\\', 'win32')).toBe('c:\\');
    expect(cacheKey('/a/b/', 'linux')).toBe('/a/b/');
  });
});

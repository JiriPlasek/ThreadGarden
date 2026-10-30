import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchProjects } from '../../src/history/watcher.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-watch-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchProjects', () => {
  it('watcher reports session ids for changed jsonl files and ignores others', async () => {
    await mkdir(join(dir, 'proj-a'));
    const seen: string[][] = [];
    const w = watchProjects(dir, (ids) => seen.push(ids), { debounceMs: 100 });
    await sleep(200);
    await writeFile(join(dir, 'proj-a', 'abc-123.jsonl'), 'x');
    await writeFile(join(dir, 'proj-a', 'notes.txt'), 'x');
    await writeFile(join(dir, 'proj-a', 'def-456.jsonl'), 'x');
    await until(() => seen.flat().includes('abc-123') && seen.flat().includes('def-456'));
    await sleep(300);
    w.close();
    expect(new Set(seen.flat())).toEqual(new Set(['abc-123', 'def-456']));
  });

  it('watcher never opens files', async () => {
    await mkdir(join(dir, 'p'));
    const seen: string[][] = [];
    const w = watchProjects(dir, (ids) => seen.push(ids), { debounceMs: 50 });
    await sleep(150);
    // Spy only after the test's own write, so only the watcher's reaction is observed.
    await writeFile(join(dir, 'p', 's1.jsonl'), 'x');
    const spies = [
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'createReadStream'),
      vi.spyOn(fs.promises, 'open'),
      vi.spyOn(fs.promises, 'readFile'),
    ];
    await until(() => seen.flat().includes('s1'));
    await sleep(100);
    w.close();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('coalesces a burst of writes into one callback', async () => {
    await mkdir(join(dir, 'p'));
    const seen: string[][] = [];
    const w = watchProjects(dir, (ids) => seen.push(ids), { debounceMs: 200 });
    await sleep(150);
    for (let i = 0; i < 5; i++) await writeFile(join(dir, 'p', 'same.jsonl'), String(i));
    await until(() => seen.length > 0);
    await sleep(500);
    w.close();
    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen.flat().every((x) => x === 'same')).toBe(true);
  });

  it('survives a missing directory and starts watching once it appears', async () => {
    const target = join(dir, 'later', 'projects');
    const seen: string[][] = [];
    const w = watchProjects(target, (ids) => seen.push(ids), { debounceMs: 50, retryMs: 50 });
    await sleep(150);
    await mkdir(join(target, 'p'), { recursive: true });
    await sleep(300);
    await writeFile(join(target, 'p', 'late.jsonl'), 'x');
    await until(() => seen.flat().includes('late'));
    w.close();
  });

  it('close stops callbacks', async () => {
    await mkdir(join(dir, 'p'));
    const seen: string[][] = [];
    const w = watchProjects(dir, (ids) => seen.push(ids), { debounceMs: 50 });
    await sleep(150);
    w.close();
    await writeFile(join(dir, 'p', 'z.jsonl'), 'x');
    await sleep(300);
    expect(seen).toEqual([]);
  });
});

/** v1.1 §4: projects.changed on live activity (throttled) and the cached folder existence check. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FOLDER_RECHECK_MS,
  FolderCheck,
  PROJECT_ORDER_THROTTLE_MS,
  ProjectOrderNotifier,
  folderExists,
  volumeOf,
} from '../../src/history/project-activity.js';
import { ManualTimers, settle } from '../chat/live-helpers.js';

describe('ProjectOrderNotifier', () => {
  const setup = () => {
    const timers = new ManualTimers();
    let changed = false;
    const checks = vi.fn(() => changed);
    const emit = vi.fn();
    const n = new ProjectOrderNotifier({ changed: checks, emit, timers, now: timers.now });
    return { timers, n, checks, emit, setChanged: (v: boolean) => (changed = v) };
  };

  it('checks the order after activity, off the caller stack, and emits only on a change', () => {
    const t = setup();
    t.n.notify();
    expect(t.checks).not.toHaveBeenCalled();
    t.timers.advance(0);
    expect(t.checks).toHaveBeenCalledTimes(1);
    expect(t.emit).not.toHaveBeenCalled();

    t.timers.advance(PROJECT_ORDER_THROTTLE_MS);
    t.setChanged(true);
    t.n.notify();
    t.timers.advance(0);
    expect(t.checks).toHaveBeenCalledTimes(2);
    expect(t.emit).toHaveBeenCalledTimes(1);
  });

  it('checks at most once per second however much activity there is', () => {
    const t = setup();
    t.setChanged(true);
    for (let i = 0; i < 50; i++) {
      t.n.notify();
      t.timers.advance(40); // a streaming reply: an event every 40 ms for 2 s
    }
    expect(t.timers.now() - 1_000_000).toBe(2_000);
    expect(t.checks.mock.calls.length).toBeLessThanOrEqual(3);
    expect(t.emit.mock.calls.length).toBeLessThanOrEqual(3);
    // emissions are ≥ 1 s apart
    t.checks.mockClear();
    t.n.notify();
    t.n.notify();
    t.timers.advance(PROJECT_ORDER_THROTTLE_MS - 1);
    t.n.notify();
    t.timers.advance(1);
    expect(t.checks).toHaveBeenCalledTimes(1);
  });

  it('contains a failing check and stops after dispose', () => {
    const timers = new ManualTimers();
    const onError = vi.fn();
    const n = new ProjectOrderNotifier({
      changed: () => {
        throw new Error('db is locked');
      },
      emit: () => {},
      timers,
      now: timers.now,
      onError,
    });
    n.notify();
    expect(() => timers.advance(0)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    timers.advance(PROJECT_ORDER_THROTTLE_MS);
    n.notify();
    n.dispose();
    expect(timers.pending).toBe(0);
    n.notify();
    expect(timers.pending).toBe(0);
  });
});

describe('FolderCheck', () => {
  const setup = (initiallyMissing: string[] = []) => {
    let t = 0;
    const missing = new Set(initiallyMissing);
    const stat = vi.fn(async (p: string) => !missing.has(p));
    const onChange = vi.fn();
    const check = new FolderCheck({ stat, now: () => t, onChange });
    return { check, stat, onChange, missing, advance: (ms: number) => (t += ms) };
  };

  it('answers from the cache and checks unknown paths in the background', async () => {
    const f = setup(['/gone']);
    // Unknown yet: assumed to exist (never moved to "Missing folders" on a guess).
    expect(f.check.exists('/gone')).toBe(true);
    expect(f.check.exists('/here')).toBe(true);
    await settle();
    expect(f.stat.mock.calls.map((c) => c[0]).sort()).toEqual(['/gone', '/here']);
    expect(f.onChange).toHaveBeenCalledTimes(1); // one batch, one notification
    expect(f.check.exists('/gone')).toBe(false);
    expect(f.check.exists('/here')).toBe(true);
    await settle();
    expect(f.stat).toHaveBeenCalledTimes(2); // cached
  });

  it('re-checks a path at most every 60 s', async () => {
    const f = setup();
    f.check.exists('/p');
    await settle();
    f.missing.add('/p');
    f.advance(FOLDER_RECHECK_MS - 1);
    expect(f.check.exists('/p')).toBe(true);
    await settle();
    expect(f.stat).toHaveBeenCalledTimes(1);
    expect(f.onChange).not.toHaveBeenCalled();
    f.advance(1);
    expect(f.check.exists('/p')).toBe(true); // stale answer now, fresh one shortly
    await settle();
    expect(f.stat).toHaveBeenCalledTimes(2);
    expect(f.onChange).toHaveBeenCalledTimes(1);
    expect(f.check.exists('/p')).toBe(false);
    // the folder comes back
    f.missing.delete('/p');
    f.advance(FOLDER_RECHECK_MS);
    f.check.exists('/p');
    await settle();
    expect(f.check.exists('/p')).toBe(true);
    expect(f.onChange).toHaveBeenCalledTimes(2);
  });

  it('refresh re-checks the given paths at once (after a sync)', async () => {
    const f = setup();
    f.check.exists('/a');
    await settle();
    f.missing.add('/a');
    await f.check.refresh(['/a', '/b']);
    expect(f.check.exists('/a')).toBe(false);
    expect(f.check.exists('/b')).toBe(true);
    expect(f.onChange).toHaveBeenCalledTimes(1);
    await f.check.refresh(['/a', '/b']); // nothing changed: no notification
    expect(f.onChange).toHaveBeenCalledTimes(1);
  });

  /** A stat whose answers the test gives by hand; tracks how many run at once. */
  const slowStat = () => {
    const answer = new Map<string, (exists: boolean) => void>();
    const stats = { running: 0, peak: 0, started: [] as string[] };
    const stat = (p: string) =>
      new Promise<boolean>((resolve) => {
        stats.running++;
        stats.peak = Math.max(stats.peak, stats.running);
        stats.started.push(p);
        answer.set(p, (exists) => {
          stats.running--;
          resolve(exists);
        });
      });
    return { stat, answer, stats };
  };

  it('runs at most 2 checks at a time and caches each answer as it arrives', async () => {
    const s = slowStat();
    const onChange = vi.fn();
    const check = new FolderCheck({ stat: s.stat, onChange });
    for (const p of ['C:\\a', 'D:\\b', 'E:\\c', 'F:\\d']) check.exists(p);
    await settle();
    expect(s.stats.started).toEqual(['C:\\a', 'D:\\b']);

    s.answer.get('D:\\b')!(false); // C:\a is still out
    await settle();
    expect(check.exists('D:\\b')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(s.stats.started).toEqual(['C:\\a', 'D:\\b', 'E:\\c']);
    s.answer.get('E:\\c')!(true);
    await settle();
    s.answer.get('F:\\d')!(false);
    await settle();
    expect(check.exists('F:\\d')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(s.stats.peak).toBe(2);
    // The slow path is never stat-ed twice at once.
    check.exists('C:\\a');
    await settle();
    expect(s.stats.started.filter((p) => p === 'C:\\a')).toHaveLength(1);
  });

  it('a hung network share holds only its own volume', async () => {
    const s = slowStat();
    const check = new FolderCheck({ stat: s.stat, onChange: () => {} });
    const share = ['\\\\nas\\work\\a', '\\\\nas\\work\\b', '\\\\nas\\work\\c'];
    const local = ['C:\\x', 'C:\\y', '/home/me/z'];
    for (const p of [...share, ...local]) check.exists(p);
    await settle();
    // One stat on the share at a time; the other slot serves the local folders.
    expect(s.stats.started).toEqual([share[0], local[0]]);
    s.answer.get(local[0]!)!(false);
    await settle();
    s.answer.get(local[1]!)!(true);
    await settle();
    s.answer.get(local[2]!)!(false);
    await settle();
    expect(local.map((p) => check.exists(p))).toEqual([false, true, false]);
    expect(s.stats.started.filter((p) => p.startsWith('\\\\nas'))).toEqual([share[0]]);
    // Paths on the hung share keep their (default) answer meanwhile.
    expect(share.map((p) => check.exists(p))).toEqual([true, true, true]);
    expect(s.stats.peak).toBe(2);
    // When the share answers, its other folders are checked in turn.
    s.answer.get(share[0]!)!(false);
    await settle();
    expect(s.stats.started.at(-1)).toBe(share[1]);
  });

  it('volumeOf names drive letters, UNC shares and POSIX mount points', () => {
    expect(volumeOf('C:\\work\\threadgarden')).toBe('c:');
    expect(volumeOf('\\\\NAS\\Work\\repo')).toBe('//nas/work');
    expect(volumeOf('//nas/work/repo')).toBe('//nas/work');
    expect(volumeOf('/mnt/nas/repo')).toBe('/mnt/nas');
    expect(volumeOf('/work')).toBe('/work');
  });

  it('a failing stat keeps the folder listed as existing', async () => {
    const onChange = vi.fn();
    const check = new FolderCheck({
      stat: () => Promise.reject(new Error('boom')),
      onChange,
    });
    await check.refresh(['/x']);
    expect(check.exists('/x')).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the default stat tells directories from missing paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-folders-'));
    try {
      expect(await folderExists(dir)).toBe(true);
      expect(await folderExists(join(dir, 'nope'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await folderExists(dir)).toBe(false);
  });
});

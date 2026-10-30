import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventMsg } from '@pahub/protocol';
import { ExternalPoller, parseAgents } from '../../src/external/poller.js';

const SAMPLE = [
  {
    id: '979fd9f6',
    cwd: 'C:\\w\\fe',
    kind: 'background',
    startedAt: 1786981960082,
    sessionId: '979fd9f6-4f60',
    name: 'Add buttons',
    state: 'blocked',
  },
  {
    pid: 9736,
    cwd: 'C:\\w\\sts',
    kind: 'interactive',
    startedAt: 1793317678086,
    sessionId: '525ce1a7',
    name: 'sts-4f',
    status: 'busy',
  },
  {
    pid: 5,
    cwd: '/x',
    kind: 'interactive',
    startedAt: 3,
    status: 'waiting',
    waitingFor: 'permission prompt',
    futureField: { nested: true },
  },
];

const make = (run: (args: string[]) => Promise<string>, own: string[] = []) => {
  const events: EventMsg[] = [];
  const poller = new ExternalPoller(
    run,
    () => new Set(own),
    (e) => events.push(e),
  );
  return { poller, events };
};

afterEach(() => vi.useRealTimers());

describe('parseAgents', () => {
  it('parses claude agents output with unknown fields', () => {
    const list = parseAgents(JSON.stringify(SAMPLE));
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      shortId: '979fd9f6',
      sessionId: '979fd9f6-4f60',
      cwd: 'C:\\w\\fe',
      kind: 'background',
      state: 'blocked',
      name: 'Add buttons',
    });
    expect(list[0]!.pid).toBeUndefined();
    expect(list[1]).toMatchObject({ pid: 9736, status: 'busy' });
    expect(list[2]).toMatchObject({ waitingFor: 'permission prompt' });
    expect(list[2]!.raw).toMatchObject({ futureField: { nested: true } });
  });

  it('is lenient about wrong types and missing fields', () => {
    const [e] = parseAgents(JSON.stringify([{ pid: '12', cwd: 5, state: 3, kind: 'x' }]));
    expect(e).toMatchObject({ kind: 'x', cwd: '' });
    expect(e!.pid).toBeUndefined();
    expect(e!.state).toBeUndefined();
    expect(e!.raw).toMatchObject({ pid: '12' });
  });

  it('throws on output that is not a JSON array', () => {
    expect(() => parseAgents('not json')).toThrow();
    expect(() => parseAgents('{"a":1}')).toThrow();
    expect(() => parseAgents('')).toThrow();
  });
});

describe('ExternalPoller', () => {
  it('runs claude agents --json --all', async () => {
    const run = vi.fn(async () => JSON.stringify(SAMPLE));
    const { poller } = make(run);
    await poller.refresh();
    expect(run).toHaveBeenCalledWith(['agents', '--json', '--all']);
    expect(poller.available).toBe(true);
    expect(poller.snapshot()).toHaveLength(3);
  });

  it('poller marks unavailable when command fails and keeps running', async () => {
    vi.useFakeTimers();
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error('spawn claude ENOENT');
      return JSON.stringify(SAMPLE);
    });
    const { poller, events } = make(run);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.available).toBe(false);
    expect(poller.snapshot()).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poller.available).toBe(true);
    expect(poller.snapshot()).toHaveLength(3);
    expect(events.filter((e) => e.event === 'external.changed').length).toBeGreaterThan(0);
    poller.stop();
  });

  it('filters pahub-owned sessions', async () => {
    const { poller } = make(async () => JSON.stringify(SAMPLE), ['525ce1a7']);
    await poller.refresh();
    expect(poller.snapshot().map((e) => e.sessionId)).toEqual(['979fd9f6-4f60', undefined]);
  });

  it('emits external.changed only on change', async () => {
    let payload: unknown[] = SAMPLE;
    const { poller, events } = make(async () => JSON.stringify(payload));
    await poller.refresh();
    expect(events).toHaveLength(1);
    await poller.refresh();
    await poller.refresh();
    expect(events).toHaveLength(1);
    payload = [{ ...SAMPLE[1]!, status: 'idle' }];
    await poller.refresh();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ event: 'external.changed', data: {} });
  });

  it('emits once when availability flips even with nothing running', async () => {
    const { poller, events } = make(async () => '[]');
    await poller.refresh();
    expect(poller.available).toBe(true);
    expect(events).toHaveLength(1);
    await poller.refresh();
    expect(events).toHaveLength(1);
  });

  it('polls every 2 s visible and every 10 s hidden', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => '[]');
    const { poller } = make(run);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.setVisible(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('never overlaps two runs', async () => {
    let inflight = 0;
    let max = 0;
    const run = async () => {
      max = Math.max(max, ++inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return '[]';
    };
    const { poller } = make(run);
    await Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
    expect(max).toBe(1);
  });

  it('skips polling while disabled and reports unavailable', async () => {
    const run = vi.fn(async () => JSON.stringify(SAMPLE));
    let on = true;
    const events: EventMsg[] = [];
    const poller = new ExternalPoller(
      run,
      () => new Set(),
      (e) => events.push(e),
      {
        enabled: () => on,
      },
    );
    await poller.refresh();
    expect(poller.available).toBe(true);
    on = false;
    await poller.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    expect(poller.available).toBe(false);
    expect(poller.snapshot()).toEqual([]);
  });
});

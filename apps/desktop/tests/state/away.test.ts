import type { AwayItem, AwayState as AwayMachine } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../../src/lib/state/api';
import { AwayState } from '../../src/lib/state/away.svelte';

const item = (id: string, over: Partial<AwayItem> = {}): AwayItem => ({
  id,
  machineId: 'm1',
  sessionId: 's1',
  kind: 'send',
  text: `message ${id}`,
  imageCount: 0,
  cwd: null,
  createdAt: 1,
  state: 'waiting',
  reason: null,
  error: null,
  ...over,
});

/** The local service: `away.list` answers `list`, `emit` sends `away.changed`, `open` reconnects. */
const fakeLocal = (list: { items: AwayItem[]; states: AwayMachine[] }) => {
  const changed = new Set<(e: unknown) => void>();
  const opens = new Set<() => void>();
  const request = vi.fn(async (method: string, params: unknown) => {
    void params;
    if (method === 'away.list') return list;
    return {};
  });
  const api = {
    status: 'open',
    request,
    on: (event: string, cb: (e: unknown) => void) => {
      if (event === 'away.changed') changed.add(cb);
      return () => changed.delete(cb);
    },
    onOpen: (cb: () => void) => {
      opens.add(cb);
      return () => opens.delete(cb);
    },
    onReconnect: () => () => {},
    onStatus: () => () => {},
  };
  return {
    api: api as unknown as Api,
    request,
    emit: (e: { items: AwayItem[]; states: AwayMachine[] }) => changed.forEach((cb) => cb(e)),
    open: () => opens.forEach((cb) => cb()),
  };
};

describe('the messages waiting for a machine that is away', () => {
  it('mirrors away.list, then every away.changed', async () => {
    const local = fakeLocal({
      items: [item('a'), item('b', { sessionId: 's2' }), item('c', { machineId: 'm2' })],
      states: [{ machineId: 'm1', starting: true, startedAt: 5 }],
    });
    const away = new AwayState();
    away.init(local.api);
    await vi.waitFor(() =>
      expect(away.items({ machineId: 'm1', sessionId: 's1' }).map((i) => i.id)).toEqual(['a']),
    );
    expect(away.items({ machineId: 'm2', sessionId: 's1' }).map((i) => i.id)).toEqual(['c']);
    expect(away.starting('m1')).toBe(true);
    expect(away.starting('m2')).toBe(false);

    local.emit({
      items: [item('a', { state: 'failed', reason: 'start' })],
      states: [{ machineId: 'm1', starting: false, startedAt: null }],
    });
    expect(away.items({ machineId: 'm1', sessionId: 's1' })).toEqual([
      item('a', { state: 'failed', reason: 'start' }),
    ]);
    expect(away.items({ machineId: 'm1', sessionId: 's2' })).toEqual([]);
    expect(away.starting('m1')).toBe(false);

    // The local service restarted: the list is read again.
    local.open();
    await vi.waitFor(() =>
      expect(away.items({ machineId: 'm1', sessionId: 's2' }).map((i) => i.id)).toEqual(['b']),
    );
  });

  it('cancels a message and retries a machine through the local service', async () => {
    const local = fakeLocal({ items: [], states: [] });
    const away = new AwayState();
    away.init(local.api);
    await away.cancel('a');
    await away.retry('m1');
    expect(local.request).toHaveBeenCalledWith('away.cancel', { id: 'a' });
    expect(local.request).toHaveBeenCalledWith('away.retry', { machineId: 'm1' });
  });
});

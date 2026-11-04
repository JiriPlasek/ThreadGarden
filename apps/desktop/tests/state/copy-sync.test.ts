import type { ChatSummary, Project } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../../src/lib/state/api';
import { CopySync } from '../../src/lib/state/copy-sync.svelte';
import type { MachineScope } from '../../src/lib/state/scope';

type Handler = (params: never) => unknown;

/** A fake client: `handlers` answer by method, `emit` fires an event, `open`/`away` move the link. */
const fakeApi = (handlers: Record<string, Handler>) => {
  // Params are read loosely by the assertions below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: { method: string; params: Record<string, any> }[] = [];
  const events = new Map<string, Set<() => void>>();
  const opens = new Set<() => void>();
  const statuses = new Set<(s: string) => void>();
  const api = {
    status: 'open',
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params: params as Record<string, never> });
      const h = handlers[method];
      if (!h) throw new Error(`no handler for ${method}`);
      return h(params as never);
    }),
    on: (event: string, cb: () => void) => {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event)!.add(cb);
      return () => events.get(event)!.delete(cb);
    },
    onReconnect: () => () => {},
    onOpen: (cb: () => void) => {
      opens.add(cb);
      return () => opens.delete(cb);
    },
    onStatus: (cb: (s: string) => void) => {
      statuses.add(cb);
      return () => statuses.delete(cb);
    },
  };
  return {
    api: api as unknown as Api & { status: string },
    calls,
    emit: (event: string) => events.get(event)?.forEach((cb) => cb()),
    open: () => {
      api.status = 'open';
      statuses.forEach((cb) => cb('open'));
      opens.forEach((cb) => cb());
    },
    away: () => {
      api.status = 'reconnecting';
      statuses.forEach((cb) => cb('reconnecting'));
    },
    count: (method: string) => calls.filter((c) => c.method === method).length,
  };
};

const chat = (id: string, lastActivity: number): ChatSummary =>
  ({ sessionId: id, lastActivity, projectId: 'p1' }) as unknown as ChatSummary;
const project = { projectId: 'p1' } as unknown as Project;

const setup = (opts: { tails?: Record<string, number>; chats?: ChatSummary[] } = {}) => {
  const remote = fakeApi({
    'projects.list': () => [project],
    'sessions.list': () => ({ items: opts.chats ?? [chat('a', 10), chat('b', 20)] }),
    'chat.open': ((p: { sessionId: string }) => ({
      summary: chat(p.sessionId, 99),
      items: [
        { kind: 'user', text: 'hi' },
        { kind: 'toolCall' },
        { kind: 'assistantText', text: 'yo' },
      ],
    })) as Handler,
  });
  const local = fakeApi({
    'copies.saveLists': () => ({}),
    'copies.saveChat': () => ({}),
    'copies.tails': () => opts.tails ?? {},
  });
  const sync = new CopySync();
  let attach: (scope: MachineScope) => void = () => {};
  sync.init({
    local: local.api,
    scopes: { observe: (cb: typeof attach) => ((attach = cb), () => {}) } as never,
    machines: { get: () => ({ info: { name: 'kumbal' } }) } as never,
    debounceMs: 2000,
  });
  attach({ machineId: 'm1', api: remote.api } as MachineScope);
  return { remote, local };
};

describe('CopySync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("on connect the lists are saved and changed chats' tails refreshed", async () => {
    const { remote, local } = setup();
    remote.open();
    await vi.advanceTimersByTimeAsync(0);
    const lists = local.calls.find((c) => c.method === 'copies.saveLists')!;
    expect(lists.params).toMatchObject({ machineId: 'm1', info: { name: 'kumbal' } });
    expect(lists.params.chats).toHaveLength(2);
    expect(remote.calls.find((c) => c.method === 'sessions.list')!.params.place).toEqual({
      kind: 'project',
      projectId: 'p1',
      include: ['onHold', 'archived'],
    });
    expect(remote.count('chat.open')).toBe(2);
    const saved = local.calls.filter((c) => c.method === 'copies.saveChat');
    expect(saved).toHaveLength(2);
    expect(saved[0]!.params.items.map((i: { kind: string }) => i.kind)).toEqual([
      'user',
      'assistantText',
    ]);
  });

  it("an unchanged chat's tail isn't fetched again", async () => {
    const { remote } = setup({ tails: { a: 10, b: 5 } });
    remote.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.calls.filter((c) => c.method === 'chat.open').map((c) => c.params.sessionId)).toEqual(['b']);
  });

  it('a change saves again after the debounce, not before', async () => {
    const { remote, local } = setup();
    remote.open();
    await vi.advanceTimersByTimeAsync(0);
    remote.emit('sessions.changed');
    remote.emit('projects.changed');
    await vi.advanceTimersByTimeAsync(1900);
    expect(local.count('copies.saveLists')).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(local.count('copies.saveLists')).toBe(2);
  });

  it('nothing is fetched while the machine is away', async () => {
    const { remote, local } = setup();
    remote.open();
    await vi.advanceTimersByTimeAsync(0);
    remote.away();
    const before = remote.calls.length;
    remote.emit('sessions.changed');
    await vi.advanceTimersByTimeAsync(5000);
    expect(remote.calls.length).toBe(before);
    expect(local.count('copies.saveLists')).toBe(1);
  });
});

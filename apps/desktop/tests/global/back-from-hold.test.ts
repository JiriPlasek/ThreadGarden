import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLDS_ANNOUNCED_KEY, startAttention } from '../../src/lib/notifications';
import { here, setup, summary } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

type ListParams = { place: { kind: string } };

const flush = () => new Promise((r) => setTimeout(r, 20));
/** Live announcements are batched for `BATCH_MS` (shortened here); this waits past that. */
const BATCH_MS = 10;
const settle = () => new Promise((r) => setTimeout(r, BATCH_MS + 50));
const focus = () => window.dispatchEvent(new Event('focus'));
const blur = () => window.dispatchEvent(new Event('blur'));

const back = (sessionId: string) => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
});

const stops: (() => void)[] = [];

/**
 * A fake service whose Needs you lists `backIds` as back from hold, with a
 * real `uiState` store (shared across "restarts" through `store`) and
 * notifications on unless `notifications` is false.
 */
const start = async (
  o: {
    backIds?: Set<string>;
    store?: Map<string, unknown>;
    notifications?: boolean;
    configure?: (s: FakeServer) => void;
  } = {},
) => {
  const backIds = o.backIds ?? new Set<string>();
  const store = o.store ?? new Map<string, unknown>();
  const env = await setup((server) => {
    server.handlers['uiState.get'] = (p) => ({
      value: store.get((p as { key: string }).key) ?? null,
    });
    server.handlers['uiState.set'] = (p) => {
      const { key, value } = p as { key: string; value: unknown };
      store.set(key, value);
      return {};
    };
    server.handlers['settings.get'] = () => ({
      claudePath: null,
      idleReclaimMinutes: 15,
      notifications: o.notifications ?? true,
      enterToSend: true,
      theme: 'system',
      startOnLogin: false,
      externalPolling: true,
      notifyOnFinish: true,
    });
    server.handlers['sessions.list'] = (p) =>
      (p as ListParams).place.kind === 'needsYou'
        ? {
            items: [...backIds].map((id) => summary(id, { status: 'history', backFromHold: true })),
          }
        : { items: [] };
    server.handlers['sessions.summaries'] = (p) => ({
      items: (p as { sessionIds: string[] }).sessionIds.map((id) =>
        summary(id, { backFromHold: backIds.has(id) }),
      ),
    });
    o.configure?.(server);
  });
  const notify = vi.fn(async (title: string, body: string, chatKey: string) => {
    void [title, body, chatKey];
  });
  if (o.notifications === false) {
    env.app.settings.value = { ...env.app.settings.value, notifications: false };
  }
  const stop = startAttention({
    scopes: env.app.scopes,
    machines: env.app.machines,
    settings: env.app.settings,
    tabs: env.app.tabs,
    places: env.app.places,
    notify,
    setTrayNeedsYou: vi.fn(async () => {}),
    backFromHoldBatchMs: BATCH_MS,
  });
  stops.push(stop);
  return { ...env, notify, store, backIds };
};

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('"Back from hold" notifications (v1.2 §3)', () => {
  it('chatBackFromHold posts "‹title› is back from hold" unless the chat is on screen', async () => {
    const env = await start();
    await flush();
    blur();
    env.server.push('chatBackFromHold', back('h1'));
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalledTimes(1));
    expect(env.notify.mock.calls[0]).toEqual(['Chat h1 is back from hold', 'alpha', here('h1')]);

    // On screen in a focused window: no notification.
    env.app.tabs.openTab('h2');
    focus();
    env.server.push('chatBackFromHold', back('h2'));
    await settle();
    expect(env.notify).toHaveBeenCalledTimes(1);

    // Notifications turned off in settings: nothing.
    env.app.settings.value = { ...env.app.settings.value, notifications: false };
    env.server.push('chatBackFromHold', back('h3'));
    await settle();
    expect(env.notify).toHaveBeenCalledTimes(1);
  });

  it('holds that end together are one notification and one save (a bulk hold)', async () => {
    const store = new Map<string, unknown>();
    const env = await start({ store });
    await flush();
    blur();
    const saves = () =>
      env.server
        .calls('uiState.set')
        .filter((c) => (c.params as { key: string }).key === HOLDS_ANNOUNCED_KEY).length;
    const before = saves();
    for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) env.server.push('chatBackFromHold', back(id));
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalledTimes(1));
    await settle();
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify.mock.calls[0]).toEqual([
      'Chat h1 and 4 more are back from hold',
      '',
      here('h1'),
    ]);
    expect(saves()).toBe(before + 1);
    expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  it('a live announcement during the connect-time catch-up is not repeated by it', async () => {
    let releaseList: () => void = () => {};
    const backIds = new Set(['h1']);
    const env = await start({
      backIds,
      configure: (server) => {
        const list = server.handlers['sessions.list']!;
        server.handlers['sessions.list'] = (p) =>
          (p as ListParams).place.kind === 'needsYou'
            ? new Promise((r) => (releaseList = () => r(list(p))))
            : list(p);
      },
    });
    blur();
    await flush();
    env.server.push('chatBackFromHold', back('h1'));
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalledTimes(1));
    releaseList();
    await settle();
    expect(env.notify).toHaveBeenCalledTimes(1);
  });

  it('on connect, holds that ended meanwhile are announced once, also across restarts', async () => {
    const store = new Map<string, unknown>();
    const backIds = new Set(['h1']);
    const first = await start({ store, backIds });
    blur();
    await vi.waitFor(() => expect(first.notify).toHaveBeenCalledTimes(1));
    // The project's name comes from the chat's folder while projects are not loaded.
    expect(first.notify.mock.calls[0]).toEqual(['Chat h1 is back from hold', 'alpha', here('h1')]);
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h1']));

    // Reconnect: nothing new.
    const lists = first.server.calls('sessions.list').length;
    first.server.drop();
    await vi.waitFor(() => expect(first.server.calls('hello')).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() =>
      expect(first.server.calls('sessions.list').length).toBeGreaterThan(lists),
    );
    await flush();
    expect(first.notify).toHaveBeenCalledTimes(1);
    for (const stop of stops.splice(0)) stop();

    // "Restart": the stored ids are not announced again; a new one is.
    backIds.add('h2');
    const second = await start({ store, backIds });
    await vi.waitFor(() => expect(second.notify).toHaveBeenCalledTimes(1));
    expect(second.notify.mock.calls[0]![2]).toBe(here('h2'));
    await vi.waitFor(() =>
      expect([...((store.get(HOLDS_ANNOUNCED_KEY) as string[]) ?? [])].sort()).toEqual([
        'h1',
        'h2',
      ]),
    );
  });

  it('several at once: one notification naming the first and how many more', async () => {
    const env = await start({ backIds: new Set(['h1', 'h2', 'h3']) });
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalledTimes(1));
    expect(env.notify.mock.calls[0]![0]).toBe('Chat h1 and 2 more are back from hold');
  });

  it('on connect, an announced chat missing from the list (busy, or beyond its end) is kept', async () => {
    const store = new Map<string, unknown>([[HOLDS_ANNOUNCED_KEY, ['gone-busy']]]);
    const env = await start({ store, backIds: new Set(['h1']) });
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect([...(store.get(HOLDS_ANNOUNCED_KEY) as string[])].sort()).toEqual(['gone-busy', 'h1']),
    );
  });

  it('with notifications off, nothing is posted but the chats count as announced', async () => {
    const store = new Map<string, unknown>();
    const env = await start({ store, backIds: new Set(['h1']), notifications: false });
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h1']));
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('forgets a chat once it is no longer back from hold, so its next hold is announced', async () => {
    const store = new Map<string, unknown>();
    const backIds = new Set(['h1']);
    const env = await start({ store, backIds });
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h1']));
    // Seen (or put on hold again): the service says the chat changed.
    backIds.delete('h1');
    env.server.push('sessions.changed', { sessionIds: ['h1'] });
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual([]));
    // A chat that works (or waits on the user) reads as not back from hold for
    // the moment: it stays announced, so it is not announced again later.
    backIds.add('h2');
    env.server.push('chatBackFromHold', back('h2'));
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h2']));
    env.server.handlers['sessions.summaries'] = (p) => ({
      items: (p as { sessionIds: string[] }).sessionIds.map((id) =>
        summary(id, { status: 'working', live: true, backFromHold: false }),
      ),
    });
    env.server.push('sessions.changed', { sessionIds: ['h2'] });
    await settle();
    expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h2']);
    // Unrelated changes ask nothing.
    const asked = env.server.calls('sessions.summaries').length;
    env.server.push('sessions.changed', { sessionIds: ['zz'] });
    await flush();
    expect(env.server.calls('sessions.summaries')).toHaveLength(asked);
  });

  it('forgets a busy announced chat put on hold again, so the end of that hold is announced', async () => {
    const store = new Map<string, unknown>();
    const env = await start({ store });
    await flush();
    env.server.push('chatBackFromHold', back('h1'));
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual(['h1']));
    // It works (not flagged for the moment), and the user puts it on hold again.
    env.server.handlers['sessions.summaries'] = (p) => ({
      items: (p as { sessionIds: string[] }).sessionIds.map((id) =>
        summary(id, { status: 'working', live: true, bucket: 'onHold', backFromHold: false }),
      ),
    });
    env.server.push('sessions.changed', { sessionIds: ['h1'] });
    await vi.waitFor(() => expect(store.get(HOLDS_ANNOUNCED_KEY)).toEqual([]));
    // That hold ends while no window is connected: the next connect announces it.
    const again = await start({ store, backIds: new Set(['h1']) });
    await vi.waitFor(() => expect(again.notify).toHaveBeenCalledTimes(1));
  });

  it('focusing soon after the notification shows Needs you (Ruling R26)', async () => {
    const env = await start();
    await flush();
    blur();
    env.server.push('chatBackFromHold', back('h1'));
    await vi.waitFor(() => expect(env.notify).toHaveBeenCalled());
    focus();
    await vi.waitFor(() => expect(env.app.places.selected).toEqual({ kind: 'needsYou' }));
  });
});

describe('"Back from hold": viewing the chat clears it', () => {
  it('a back-from-hold chat shown in a focused window is marked seen', async () => {
    const env = await setup((server) => {
      server.handlers['chat.markSeen'] = () => ({});
      server.handlers['sessions.list'] = () => ({
        items: [summary('b1', { backFromHold: true }), summary('r1')],
      });
    });
    await env.app.sessions.reload();
    // The harness started it like the app does; re-init with a test debounce (init stops it first).
    const yourTurn = env.app.scopes.local().yourTurn;
    yourTurn.init(env.client, { ...env.app, tabs: env.app.scopes.local().tabs }, { debounceMs: 0 });
    stops.push(yourTurn.stop);
    focus();
    env.app.tabs.openTab('r1');
    await flush();
    expect(env.server.calls('chat.markSeen')).toHaveLength(0);
    env.app.tabs.openTab('b1');
    await vi.waitFor(() =>
      expect(env.server.calls('chat.markSeen').map((c) => c.params)).toEqual([{ sessionId: 'b1' }]),
    );
  });

  it('chatBackFromHold for the chat on screen marks it seen at once', async () => {
    const env = await setup((server) => {
      server.handlers['chat.markSeen'] = () => ({});
    });
    // The harness started it like the app does; re-init with a test debounce (init stops it first).
    const yourTurn = env.app.scopes.local().yourTurn;
    yourTurn.init(
      env.client,
      { ...env.app, tabs: env.app.scopes.local().tabs },
      { debounceMs: 60_000 },
    );
    stops.push(yourTurn.stop);
    focus();
    env.app.tabs.openTab('r1');
    await flush();
    env.server.push('chatBackFromHold', back('r1'));
    await vi.waitFor(() => expect(env.server.calls('chat.markSeen')).toHaveLength(1));
  });
});

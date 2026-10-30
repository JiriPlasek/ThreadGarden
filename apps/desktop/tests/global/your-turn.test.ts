import { afterEach, describe, expect, it, vi } from 'vitest';
import { YourTurnState } from '../../src/lib/state/your-turn.svelte';
import { setup, summary } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

const flush = () => new Promise((r) => setTimeout(r, 20));

const finished = (sessionId: string) => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
});

const stops: (() => void)[] = [];

/** A wired app whose chats `unread` lists are unread, plus the "Your turn" tracker. */
const start = async (
  o: { unread?: string[]; debounceMs?: number; configure?: (s: FakeServer) => void } = {},
) => {
  const unread = new Set(o.unread ?? []);
  const env = await setup((server) => {
    server.handlers['chat.markSeen'] = (p) => {
      unread.delete((p as { sessionId: string }).sessionId);
      return {};
    };
    server.handlers['sessions.list'] = () => ({
      items: ['u1', 'u2', 'r1'].map((id) =>
        summary(id, { status: 'idle', live: true, unread: unread.has(id) }),
      ),
    });
    server.handlers['chat.open'] = (p) => {
      const id = (p as { sessionId: string }).sessionId;
      return {
        summary: summary(id, { status: 'idle', live: true, unread: unread.has(id) }),
        header: {},
        items: [],
        hasMore: false,
        seq: 1,
      };
    };
    o.configure?.(server);
  });
  await env.app.sessions.reload();
  const yourTurn = new YourTurnState();
  yourTurn.init(env.client, env.app, { debounceMs: o.debounceMs ?? 0 });
  stops.push(yourTurn.stop);
  const seen = () =>
    env.server.calls('chat.markSeen').map((c) => (c.params as { sessionId: string }).sessionId);
  return { ...env, yourTurn, seen, unread };
};

const focus = () => window.dispatchEvent(new Event('focus'));
const blur = () => window.dispatchEvent(new Event('blur'));

describe('"Your turn": marking chats seen (v1.1 §3)', () => {
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it('opening an unread chat in a focused window marks it seen, once', async () => {
    const env = await start({ unread: ['u1'] });
    focus();
    env.app.tabs.openTab('u1');
    await vi.waitFor(() => expect(env.seen()).toEqual(['u1']));
    // Later refreshes and focus changes do not mark it again.
    await env.app.sessions.reload();
    blur();
    focus();
    await flush();
    expect(env.seen()).toEqual(['u1']);
  });

  it('a chat that is not unread is never marked', async () => {
    const env = await start({ unread: ['u1'] });
    focus();
    env.app.tabs.openTab('r1');
    await flush();
    expect(env.seen()).toEqual([]);
  });

  it('not while the window is unfocused; focusing it marks the active chat', async () => {
    const env = await start({ unread: ['u1'] });
    blur();
    env.app.tabs.openTab('u1');
    await flush();
    expect(env.seen()).toEqual([]);
    focus();
    await vi.waitFor(() => expect(env.seen()).toEqual(['u1']));
  });

  it('activating a background tab with an unread chat marks it', async () => {
    const env = await start({ unread: ['u2'] });
    focus();
    env.app.tabs.openTab('r1');
    env.app.tabs.openTab('u2');
    env.app.tabs.activate('r1');
    await flush();
    // u2 was active only for a moment (debounced away)...
    const before = env.seen().length;
    env.app.tabs.activate('u2');
    await vi.waitFor(() => expect(env.seen().length).toBe(before + 1));
    expect(env.seen().at(-1)).toBe('u2');
  });

  it('switching through tabs quickly does not mark the ones only passed through', async () => {
    const env = await start({ unread: ['u1', 'u2'], debounceMs: 100 });
    focus();
    env.app.tabs.openTab('r1');
    env.app.tabs.openTab('u1');
    env.app.tabs.openTab('u2');
    env.app.tabs.activate('r1');
    await new Promise((r) => setTimeout(r, 200));
    expect(env.seen()).toEqual([]);
  });

  it('chatFinished for the active tab of a focused window marks it at once (no debounce)', async () => {
    const env = await start({ debounceMs: 60_000 });
    focus();
    env.app.tabs.openTab('r1');
    await vi.waitFor(() => expect(env.app.chats.get('r1')?.loaded).toBe(true));
    env.unread.add('r1');
    env.server.push('chatFinished', finished('r1'));
    await vi.waitFor(() => expect(env.seen()).toEqual(['r1']));
  });

  it('chatFinished for a background tab is marked only once that tab is shown', async () => {
    const env = await start();
    focus();
    env.app.tabs.openTab('r1');
    env.app.tabs.openTab('u2');
    env.app.tabs.activate('r1');
    await flush();
    env.unread.add('u2');
    env.server.push('chatFinished', finished('u2'));
    await flush();
    expect(env.seen()).toEqual([]);
    env.app.tabs.activate('u2');
    await vi.waitFor(() => expect(env.seen()).toEqual(['u2']));
  });

  it('chatFinished while the window is unfocused is marked when it gains focus', async () => {
    const env = await start();
    focus();
    env.app.tabs.openTab('r1');
    await flush();
    blur();
    env.unread.add('r1');
    env.server.push('chatFinished', finished('r1'));
    await flush();
    expect(env.seen()).toEqual([]);
    focus();
    await vi.waitFor(() => expect(env.seen()).toEqual(['r1']));
  });

  it('a later turn of an already seen chat is marked again', async () => {
    const env = await start({ unread: ['u1'] });
    focus();
    env.app.tabs.openTab('u1');
    await vi.waitFor(() => expect(env.seen()).toEqual(['u1']));
    env.unread.add('u1');
    env.server.push('chatFinished', finished('u1'));
    await vi.waitFor(() => expect(env.seen()).toEqual(['u1', 'u1']));
  });

  it('an unread chat known only from chat.open (e.g. opened from the switcher) is marked', async () => {
    const env = await start({
      configure: (server) => {
        server.handlers['sessions.list'] = () => ({ items: [] });
        server.handlers['chat.open'] = () => ({
          summary: summary('q1', { status: 'failed', unread: true }),
          header: {},
          items: [],
          hasMore: false,
          seq: 1,
        });
      },
    });
    focus();
    env.app.tabs.openTab('q1');
    await vi.waitFor(() => expect(env.seen()).toEqual(['q1']));
  });
});

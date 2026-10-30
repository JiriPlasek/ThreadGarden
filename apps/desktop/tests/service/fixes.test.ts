import type { ChatItem, ChatSummary } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { ChatsState } from '../../src/lib/state/chats.svelte';
import { PlacesState } from '../../src/lib/state/places.svelte';
import { SessionsState } from '../../src/lib/state/sessions.svelte';
import { FakeServer, RpcFail } from './fake-ws';

const summary = (sessionId: string): ChatSummary => ({
  sessionId,
  title: sessionId,
  projectId: 'p',
  cwd: '/w',
  status: 'idle',
  preview: '',
  lastActivity: 0,
  pinned: false,
  live: true,
  external: null,
  unread: false,
});
const text = (id: string, markdown: string): ChatItem => ({
  kind: 'assistantText',
  id,
  markdown,
  streaming: false,
});
const ev = (seq: number, id: string) => ({ sessionId: 's1', seq, items: [text(id, id)] });

let server: FakeServer;
let client: ServiceClient;
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  client = new ServiceClient({ WebSocketImpl: server.Impl });
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
});

const setupChat = async () => {
  const chats = new ChatsState();
  chats.init(client, { schedule: (cb) => queueMicrotask(cb) });
  server.handlers['chat.open'] = () => ({
    summary: summary('s1'),
    header: {},
    items: [text('a', 'a')],
    hasMore: false,
    seq: 4,
  });
  const p = client.connect('ws://x:1', 't');
  await tick();
  await p;
  await chats.open('s1');
  return chats;
};

describe('resync ordering', () => {
  it('buffers live events during an in-flight chat.since and merges them after it', async () => {
    const chats = await setupChat();
    server.silent.add('chat.since');
    server.drop();
    await vi.advanceTimersByTimeAsync(250);
    expect(server.calls('chat.since')).toHaveLength(1);
    // Live event 8 arrives before the since response (which covers 5..7).
    server.push('chat.items', ev(8, 'h'));
    server.live!.deliver({
      id: server.calls('chat.since')[0]!.id,
      result: { events: [ev(5, 'e'), ev(6, 'f'), ev(7, 'g')], seq: 7 },
    });
    await tick();
    const chat = chats.get('s1')!;
    expect(chat.items.map((i) => i.id)).toEqual(['a', 'e', 'f', 'g', 'h']);
    expect(chat.seq).toBe(8);
  });

  it('keeps buffered live events across the GAP to open fallback', async () => {
    const chats = await setupChat();
    server.silent.add('chat.since');
    server.drop();
    await vi.advanceTimersByTimeAsync(250);
    server.push('chat.items', ev(9, 'live'));
    server.handlers['chat.open'] = () => ({
      summary: summary('s1'),
      header: {},
      items: [text('fresh', 'fresh')],
      hasMore: false,
      seq: 8,
    });
    server.live!.deliver({
      id: server.calls('chat.since')[0]!.id,
      error: { code: 'GAP', message: 'GAP' },
    });
    await tick();
    await tick();
    expect(chats.get('s1')!.items.map((i) => i.id)).toEqual(['fresh', 'live']);
    expect(chats.get('s1')!.seq).toBe(9);
  });
});

describe('initial fetch', () => {
  it('lists populate when init ran before the first connect', async () => {
    server.handlers['places.counts'] = () => ({ needsYou: 1, running: 2, all: 3 });
    server.handlers['projects.list'] = () => [];
    server.handlers['sessions.list'] = () => ({ items: [summary('s1')] });
    const places = new PlacesState();
    const sessions = new SessionsState();
    places.init(client);
    sessions.init(client, places);
    await tick();
    const p = client.connect('ws://x:1', 't');
    await tick();
    await p;
    await tick();
    expect(places.counts).toEqual({ needsYou: 1, running: 2, all: 3 });
    expect(sessions.items.map((s) => s.sessionId)).toEqual(['s1']);
  });
});

describe('hello failures', () => {
  it('a hello timeout retries with backoff and is not incompatible', async () => {
    server.silent.add('hello');
    const p = client.connect('ws://x:1', 't');
    await tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.status).not.toBe('incompatible');
    server.silent.delete('hello');
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(client.status).toBe('open');
    expect(server.sockets.length).toBe(2);
  });

  it('a hello error answer is incompatible', async () => {
    server.handlers['hello'] = () => {
      throw new RpcFail('INCOMPATIBLE');
    };
    const p = client.connect('ws://x:1', 't');
    const assertion = expect(p).rejects.toMatchObject({ code: 'INCOMPATIBLE' });
    await tick();
    await assertion;
    expect(client.status).toBe('incompatible');
  });
});

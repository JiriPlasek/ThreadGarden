import { PROTOCOL_VERSION, type ChatItem, type ChatSummary } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError, ServiceClient } from '../../src/lib/service/client';
import { ChatsState } from '../../src/lib/state/chats.svelte';
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
  bucket: 'active',
  backFromHold: false,
});
const text = (id: string, markdown: string): ChatItem => ({
  kind: 'assistantText',
  id,
  markdown,
  streaming: false,
});

let server: FakeServer;
let client: ServiceClient;

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  client = new ServiceClient({ WebSocketImpl: server.Impl });
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
});

const connected = async () => {
  const p = client.connect('ws://127.0.0.1:1', 'tok');
  await vi.advanceTimersByTimeAsync(0);
  await p;
};

describe('ServiceClient', () => {
  it('request resolves matching response id', async () => {
    server.handlers['places.counts'] = () => ({ needsYou: 1, running: 2, all: 3 });
    server.handlers['projects.list'] = () => [];
    await connected();
    // Both prefixes: a pahub service (before v1.3) accepts only the old one (spec v1.3 §9).
    expect(server.protocols[0]).toEqual(['threadgarden.tok', 'pahub.tok']);
    const [a, b] = await Promise.all([
      client.request('places.counts', {}),
      client.request('projects.list', {}),
    ]);
    expect(a).toEqual({ needsYou: 1, running: 2, all: 3 });
    expect(b).toEqual([]);
    expect(client.status).toBe('open');
  });

  it('rejects with the protocol error code', async () => {
    server.handlers['chat.since'] = () => {
      throw new RpcFail('GAP');
    };
    await connected();
    await expect(client.request('chat.since', { sessionId: 's', seq: 1 })).rejects.toMatchObject({
      code: 'GAP',
    });
  });

  it('refuses a request larger than the service accepts, with a clear error, without sending it', async () => {
    const { MAX_REQUEST_BYTES } = await import('@threadgarden/protocol');
    server.handlers['chat.send'] = () => ({ queued: false });
    await connected();
    const data = 'A'.repeat(MAX_REQUEST_BYTES);
    await expect(
      client.request('chat.send', {
        sessionId: 's',
        text: 'look',
        images: [{ mediaType: 'image/png', data }],
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringMatching(/too large/) });
    expect(server.calls('chat.send')).toHaveLength(0);
    // The connection is unaffected.
    expect(client.status).toBe('open');
    await expect(client.request('chat.send', { sessionId: 's', text: 'ok' })).resolves.toEqual({
      queued: false,
    });
  });

  it('times out unanswered requests after 30 s', async () => {
    server.silent.add('places.counts');
    await connected();
    const p = client.request('places.counts', {});
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('rejects pending requests with DISCONNECTED when the socket drops, and while down', async () => {
    server.silent.add('places.counts');
    await connected();
    const p = client.request('places.counts', {});
    const assertion = expect(p).rejects.toBeInstanceOf(RequestError);
    server.drop();
    await assertion;
    await expect(p).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(client.status).toBe('reconnecting');
    await expect(client.request('projects.list', {})).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
  });

  it('delivers events to subscribers until unsubscribed', async () => {
    await connected();
    const seen: unknown[] = [];
    const off = client.on('index.progress', (d) => seen.push(d));
    server.push('index.progress', { done: 1, total: 2 });
    off();
    server.push('index.progress', { done: 2, total: 2 });
    expect(seen).toEqual([{ done: 1, total: 2 }]);
  });

  it('backs off 250 ms doubling up to 5 s while the service is down', async () => {
    await connected();
    server.refuse = true;
    server.drop();
    const attempts = () => server.sockets.length;
    const base = attempts();
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts()).toBe(base);
    await vi.advanceTimersByTimeAsync(1); // 250
    expect(attempts()).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(500); // +500
    expect(attempts()).toBe(base + 2);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 5000); // 1s, 2s, 4s then capped 5s
    expect(attempts()).toBe(base + 5 + 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts()).toBe(base + 7);
  });

  it('marks incompatible on protocol mismatch', async () => {
    server.handlers['hello'] = () => ({
      serviceVersion: '9',
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    const p = client.connect('ws://127.0.0.1:1', 'tok');
    const assertion = expect(p).rejects.toMatchObject({ code: 'INCOMPATIBLE' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(client.status).toBe('incompatible');
    const before = server.sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.sockets.length).toBe(before); // no reconnect loop
  });

  it('a v1.1 service (protocol 1) is incompatible: the restart screen, never broken lists', async () => {
    // v1.2 added places (active, onHold) and methods a v1.1 service rejects.
    expect(PROTOCOL_VERSION).toBeGreaterThan(1);
    server.handlers['hello'] = () => ({ serviceVersion: '0.1.0', protocolVersion: 1 });
    const p = client.connect('ws://127.0.0.1:1', 'tok');
    const assertion = expect(p).rejects.toMatchObject({ code: 'INCOMPATIBLE' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(client.status).toBe('incompatible');
    expect(server.calls('sessions.list')).toHaveLength(0);
  });

  it('a pahub service (protocol 3) is incompatible: restarting it moves its data over', async () => {
    // v1.3 §9: the renamed data dir; the new service migrates pahub's as it starts.
    expect(PROTOCOL_VERSION).toBeGreaterThan(3);
    server.handlers['hello'] = () => ({ serviceVersion: '0.2.0', protocolVersion: 3 });
    const p = client.connect('ws://127.0.0.1:1', 'tok');
    const assertion = expect(p).rejects.toMatchObject({ code: 'INCOMPATIBLE' });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(client.status).toBe('incompatible');
  });

  it('reconnects and resyncs after reconnect without duplicates', async () => {
    const chats = new ChatsState();
    chats.init(client, { schedule: (cb) => queueMicrotask(cb) });
    server.handlers['chat.open'] = () => ({
      summary: summary('s1'),
      header: {},
      items: [text('a', 'one')],
      hasMore: false,
      seq: 3,
    });
    await connected();
    await chats.open('s1');
    server.push('chat.items', { sessionId: 's1', seq: 4, items: [text('b', 'two')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(chats.get('s1')?.seq).toBe(4);

    server.handlers['chat.since'] = () => ({
      // seq 4 was already seen (broadcast at the same time); 5 is new; 'b' is replaced.
      events: [
        { sessionId: 's1', seq: 4, items: [text('b', 'two')] },
        { sessionId: 's1', seq: 5, items: [text('b', 'two!'), text('c', 'three')], replace: true },
      ],
      seq: 5,
    });
    server.drop();
    await vi.advanceTimersByTimeAsync(250);

    expect(client.status).toBe('open');
    expect(server.calls('hello')).toHaveLength(2);
    expect(server.calls('chat.since').map((c) => c.params)).toEqual([{ sessionId: 's1', seq: 4 }]);
    const chat = chats.get('s1')!;
    expect(chat.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect((chat.items[1] as { markdown: string }).markdown).toBe('two!');
    expect(chat.seq).toBe(5);
    expect(server.calls('chat.open')).toHaveLength(1);
  });

  it('a replayed chat.tasks event advances the seq without touching the chat status', async () => {
    const chats = new ChatsState();
    chats.init(client, { schedule: (cb) => queueMicrotask(cb) });
    server.handlers['chat.open'] = () => ({
      summary: summary('s1'),
      header: {},
      items: [text('a', 'one')],
      hasMore: false,
      seq: 3,
      tasks: [],
    });
    await connected();
    await chats.open('s1');
    const status = chats.get('s1')!.status;
    server.handlers['chat.since'] = () => ({
      events: [
        {
          sessionId: 's1',
          seq: 4,
          tasks: [
            {
              taskId: 'b1',
              kind: 'shell',
              description: 'npm run dev',
              status: 'running',
              startedAt: 1,
            },
          ],
        },
      ],
      seq: 4,
    });
    server.drop();
    await vi.advanceTimersByTimeAsync(250);
    const chat = chats.get('s1')!;
    expect(chat.seq).toBe(4);
    expect(chat.status).toBe(status);
    expect(chat.items.map((i) => i.id)).toEqual(['a']);
  });

  it('falls back to chat.open when chat.since reports GAP', async () => {
    const chats = new ChatsState();
    chats.init(client, { schedule: (cb) => queueMicrotask(cb) });
    let opens = 0;
    server.handlers['chat.open'] = () => ({
      summary: summary('s1'),
      header: {},
      items: [text('fresh', String(++opens))],
      hasMore: false,
      seq: opens * 100,
    });
    await connected();
    await chats.open('s1');
    server.handlers['chat.since'] = () => {
      throw new RpcFail('GAP');
    };
    server.drop();
    await vi.advanceTimersByTimeAsync(250);
    expect(server.calls('chat.open')).toHaveLength(2);
    expect(chats.get('s1')?.seq).toBe(200);
    expect(chats.get('s1')?.items.map((i) => i.id)).toEqual(['fresh']);
  });

  it('onClose stop ends reconnecting; retry keeps the backoff; hello is kept', async () => {
    const codes: number[] = [];
    const c = new ServiceClient({
      WebSocketImpl: server.Impl,
      acceptProtocol: (v) => v === PROTOCOL_VERSION || v === 4,
      onClose: (code) => {
        codes.push(code);
        return code === 4409 ? 'stop' : 'retry';
      },
    });
    server.handlers.hello = () => ({ serviceVersion: 'x', protocolVersion: 4 });
    const p = c.connect('ws://127.0.0.1:1', 'tok');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(c.hello?.protocolVersion).toBe(4);
    server.drop(4502);
    await vi.advanceTimersByTimeAsync(300);
    expect(c.status).toBe('open');
    server.drop(4409);
    const sockets = server.sockets.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codes).toEqual([4502, 4409]);
    expect(server.sockets).toHaveLength(sockets);
    c.close();
  });
});

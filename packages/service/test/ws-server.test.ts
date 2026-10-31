import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Router, ServiceError } from '../src/server/router.js';
import { startWsServer } from '../src/server/ws-server.js';

type Server = Awaited<ReturnType<typeof startWsServer>>;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const makeRouter = () => {
  const router = new Router();
  router.register('hello', async () => ({ serviceVersion: 't', protocolVersion: 1 }));
  return router;
};
const start = async (
  router = makeRouter(),
  counts: number[] = [],
  onError?: (err: unknown) => void,
) => {
  const s = await startWsServer({
    token: 'tok',
    router,
    onClientCountChange: (n) => counts.push(n),
    ...(onError ? { onError } : {}),
  });
  servers.push(s);
  return s;
};
const open = (port: number, protocol?: string | string[]) =>
  new Promise<WebSocket>((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}`;
    const ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const nextMessage = (ws: WebSocket) =>
  new Promise<unknown>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', resolve));

describe('ws server', () => {
  it('rejects connection without token (4401)', async () => {
    const s = await start();
    const ws = await open(s.port);
    expect(await closeCode(ws)).toBe(4401);
  });
  it('rejects wrong token (4401)', async () => {
    const s = await start();
    const ws = await open(s.port, 'threadgarden.wrong');
    expect(await closeCode(ws)).toBe(4401);
  });
  it('survives a refused client that sends a broken frame', async () => {
    const s = await start();
    const ws = await open(s.port, 'threadgarden.wrong');
    ws.on('error', () => {});
    const closed = closeCode(ws);
    // A masked frame with the reserved opcode 3: the server's parser rejects it.
    (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(
      Buffer.from([0x83, 0x80, 0, 0, 0, 0]),
    );
    await closed;
    const ok = await open(s.port, 'threadgarden.tok');
    const reply = nextMessage(ok);
    ok.send(
      JSON.stringify({ id: 1, method: 'hello', params: { protocolVersion: 1, client: 'c' } }),
    );
    expect(await reply).toMatchObject({ id: 1, result: { serviceVersion: 't' } });
    ok.close();
  });
  it('accepts the legacy pahub.<token> subprotocol (spec v1.3 §9)', async () => {
    const s = await start();
    const ws = await open(s.port, 'pahub.tok');
    expect(ws.protocol).toBe('pahub.tok');
    const reply = nextMessage(ws);
    ws.send(
      JSON.stringify({ id: 1, method: 'hello', params: { protocolVersion: 1, client: 'c' } }),
    );
    expect(await reply).toMatchObject({ id: 1, result: { serviceVersion: 't' } });
    ws.close();
  });
  it('picks the first of both offered subprotocols', async () => {
    const s = await start();
    const ws = await open(s.port, ['threadgarden.tok', 'pahub.tok']);
    expect(ws.protocol).toBe('threadgarden.tok');
    ws.close();
    const legacyFirst = await open(s.port, ['other', 'pahub.tok', 'threadgarden.tok']);
    expect(legacyFirst.protocol).toBe('pahub.tok');
    legacyFirst.close();
  });
  it('rejects a wrong token under the legacy prefix too (4401)', async () => {
    const s = await start();
    const ws = await open(s.port, 'pahub.wrong');
    expect(await closeCode(ws)).toBe(4401);
  });
  it('routes hello and returns protocolVersion 1', async () => {
    const s = await start();
    const ws = await open(s.port, 'threadgarden.tok');
    expect(ws.protocol).toBe('threadgarden.tok');
    const reply = nextMessage(ws);
    ws.send(
      JSON.stringify({ id: 1, method: 'hello', params: { protocolVersion: 1, client: 'test' } }),
    );
    expect(await reply).toEqual({ id: 1, result: { serviceVersion: 't', protocolVersion: 1 } });
    ws.close();
  });
  it('serves local-only methods: its callers are local', async () => {
    const router = makeRouter();
    const origins: string[] = [];
    router.register(
      'work.stopAll',
      async (_p, ctx) => {
        origins.push(ctx.origin);
        return { stopped: 0 };
      },
      { localOnly: true },
    );
    const s = await start(router);
    const ws = await open(s.port, 'threadgarden.tok');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ id: 1, method: 'work.stopAll', params: {} }));
    expect(await reply).toEqual({ id: 1, result: { stopped: 0 } });
    expect(origins).toEqual(['local']);
    ws.close();
  });
  it('broadcasts events and tracks client count', async () => {
    const counts: number[] = [];
    const s = await start(makeRouter(), counts);
    const ws = await open(s.port, 'threadgarden.tok');
    const evt = nextMessage(ws);
    s.broadcast({ event: 'x', data: 1 });
    expect(await evt).toEqual({ event: 'x', data: 1 });
    const closed = closeCode(ws);
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(counts).toEqual([1, 0]);
  });
  it('answers malformed frames with an error and keeps the connection', async () => {
    const s = await start();
    const ws = await open(s.port, 'threadgarden.tok');
    const reply = nextMessage(ws);
    ws.send('not json');
    expect(await reply).toMatchObject({ error: { code: 'INVALID_PARAMS' } });
    ws.close();
  });
  it('a dispatch that rejects is answered INTERNAL and reported, never an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const router = makeRouter();
    vi.spyOn(router, 'dispatch').mockRejectedValue(new Error('router exploded'));
    const s = await start(router, [], (e) => errors.push(e));
    const ws = await open(s.port, 'threadgarden.tok');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ id: 7, method: 'hello', params: {} }));
    expect(await reply).toEqual({
      id: 7,
      error: { code: 'INTERNAL', message: 'Internal error' },
    });
    expect(String(errors[0])).toContain('router exploded');
    ws.close();
  });
  it('a server error after listening is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const servers: WebSocketServer[] = [];
    const address = WebSocketServer.prototype.address;
    const spy = vi.spyOn(WebSocketServer.prototype, 'address').mockImplementation(function (
      this: WebSocketServer,
    ) {
      servers.push(this);
      return address.call(this);
    });
    const s = await start(makeRouter(), [], (e) => errors.push(e));
    spy.mockRestore();
    expect(() => servers[0]!.emit('error', new Error('late failure'))).not.toThrow();
    expect(String(errors[0])).toContain('late failure');
    // Still serving.
    const ws = await open(s.port, 'threadgarden.tok');
    ws.close();
  });
  it('accepts a message as large as the documented image limits allow', async () => {
    const router = makeRouter();
    router.register('ui.visibility', async () => ({}));
    const s = await start(router);
    const ws = await open(s.port, 'threadgarden.tok');
    const reply = nextMessage(ws);
    // 20 MiB of images (the composer's per-message cap) as base64, plus the envelope.
    const data = 'A'.repeat(Math.ceil((20 * 1024 * 1024 * 4) / 3));
    ws.send(JSON.stringify({ id: 9, method: 'ui.visibility', params: { visible: true, data } }));
    expect(await reply).toMatchObject({ id: 9 });
    ws.close();
  });
  it('binds only 127.0.0.1', async () => {
    const s = await start();
    expect(s.address).toBe('127.0.0.1');
  });
});

describe('router', () => {
  const ctx = { clientId: 'c', origin: 'local' as const };
  it('returns INVALID_PARAMS for bad params', async () => {
    const res = await makeRouter().dispatch({ id: 2, method: 'hello', params: { nope: 1 } }, ctx);
    expect(res).toMatchObject({ id: 2, error: { code: 'INVALID_PARAMS' } });
  });
  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const res = await makeRouter().dispatch({ id: 3, method: 'bogus', params: {} }, ctx);
    expect(res).toMatchObject({ id: 3, error: { code: 'METHOD_NOT_FOUND' } });
  });
  it('maps ServiceError and other throws', async () => {
    const router = new Router({ error: () => {} });
    router.register('hello', async () => {
      throw new ServiceError('NOPE', 'denied');
    });
    router.register('ui.visibility', async () => {
      throw new Error('boom');
    });
    const hello = { id: 1, method: 'hello', params: { protocolVersion: 1, client: 'c' } };
    expect(await router.dispatch(hello, ctx)).toEqual({
      id: 1,
      error: { code: 'NOPE', message: 'denied' },
    });
    const vis = { id: 2, method: 'ui.visibility', params: { visible: true } };
    expect(await router.dispatch(vis, ctx)).toMatchObject({ error: { code: 'INTERNAL' } });
  });
  it('answers FORBIDDEN to a remote caller of a local-only method, before reading params', async () => {
    const router = new Router();
    const seen: unknown[] = [];
    router.register(
      'work.stopAll',
      async (_p, c) => {
        seen.push(c);
        return { stopped: 0 };
      },
      { localOnly: true },
    );
    router.register('ui.visibility', async (_p, c) => {
      seen.push(c);
      return {};
    });
    const remote = { clientId: 'r', origin: 'remote' as const, deviceId: 'd' };
    const stop = { id: 4, method: 'work.stopAll', params: {} };
    expect(await router.dispatch(stop, remote)).toMatchObject({
      id: 4,
      error: { code: 'FORBIDDEN' },
    });
    expect(
      await router.dispatch({ id: 5, method: 'work.stopAll', params: { bad: 1 } }, remote),
    ).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(seen).toEqual([]);
    expect(await router.dispatch(stop, ctx)).toEqual({ id: 4, result: { stopped: 0 } });
    const vis = { id: 6, method: 'ui.visibility', params: { visible: true } };
    expect(await router.dispatch(vis, remote)).toEqual({ id: 6, result: {} });
    expect(seen).toEqual([ctx, remote]);
  });
});

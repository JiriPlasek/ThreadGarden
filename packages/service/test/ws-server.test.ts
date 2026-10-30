import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
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
const start = async (router = makeRouter(), counts: number[] = []) => {
  const s = await startWsServer({
    token: 'tok',
    router,
    onClientCountChange: (n) => counts.push(n),
  });
  servers.push(s);
  return s;
};
const open = (port: number, protocol?: string) =>
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
    const ws = await open(s.port, 'pahub.wrong');
    expect(await closeCode(ws)).toBe(4401);
  });
  it('routes hello and returns protocolVersion 1', async () => {
    const s = await start();
    const ws = await open(s.port, 'pahub.tok');
    expect(ws.protocol).toBe('pahub.tok');
    const reply = nextMessage(ws);
    ws.send(
      JSON.stringify({ id: 1, method: 'hello', params: { protocolVersion: 1, client: 'test' } }),
    );
    expect(await reply).toEqual({ id: 1, result: { serviceVersion: 't', protocolVersion: 1 } });
    ws.close();
  });
  it('broadcasts events and tracks client count', async () => {
    const counts: number[] = [];
    const s = await start(makeRouter(), counts);
    const ws = await open(s.port, 'pahub.tok');
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
    const ws = await open(s.port, 'pahub.tok');
    const reply = nextMessage(ws);
    ws.send('not json');
    expect(await reply).toMatchObject({ error: { code: 'INVALID_PARAMS' } });
    ws.close();
  });
  it('binds only 127.0.0.1', async () => {
    const s = await start();
    expect(s.address).toBe('127.0.0.1');
  });
});

describe('router', () => {
  const ctx = { clientId: 'c' };
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
});

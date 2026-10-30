import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { RequestSchema, type EventMsg, type Request, type Response } from '@pahub/protocol';
import type { Router } from './router.js';

const HOST = '127.0.0.1';
const UNAUTHORIZED = 4401;
const PROTOCOL_PREFIX = 'pahub.';

const tokenMatches = (offered: string, token: string): boolean => {
  const a = Buffer.from(offered);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const startWsServer = async (opts: {
  token: string;
  router: Router;
  /** Fixed port (mock service); default 0 = a random free port. */
  port?: number;
  onClientCountChange(n: number): void;
}): Promise<{
  port: number;
  address: string;
  broadcast(e: EventMsg): void;
  close(): Promise<void>;
}> => {
  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({
    host: HOST,
    port: opts.port ?? 0,
    maxPayload: 16 * 1024 * 1024,
    // Echo the offered subprotocol so browsers complete the handshake; the token is verified on connection.
    handleProtocols: (protocols) =>
      [...protocols].find((p) => p.startsWith(PROTOCOL_PREFIX)) ?? false,
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  const send = (ws: WebSocket, msg: Response | EventMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws) => {
    const offered = ws.protocol.startsWith(PROTOCOL_PREFIX)
      ? ws.protocol.slice(PROTOCOL_PREFIX.length)
      : null;
    if (offered === null || !tokenMatches(offered, opts.token)) {
      ws.close(UNAUTHORIZED, 'unauthorized');
      return;
    }
    const clientId = randomUUID();
    clients.add(ws);
    opts.onClientCountChange(clients.size);
    ws.on('message', (data) => {
      let req: Request;
      try {
        req = RequestSchema.parse(JSON.parse(String(data)));
      } catch {
        send(ws, { id: 0, error: { code: 'INVALID_PARAMS', message: 'Malformed request' } });
        return;
      }
      void opts.router.dispatch(req, { clientId }).then((res) => send(ws, res));
    });
    ws.on('close', () => {
      clients.delete(ws);
      opts.onClientCountChange(clients.size);
    });
    ws.on('error', () => ws.terminate());
  });

  const addr = wss.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected server address');

  return {
    port: addr.port,
    address: addr.address,
    broadcast: (e) => {
      for (const ws of clients) send(ws, e);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
};

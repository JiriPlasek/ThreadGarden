import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_REQUEST_BYTES,
  RequestSchema,
  type EventMsg,
  type Request,
  type Response,
} from '@threadgarden/protocol';
import type { Router } from './router.js';

const HOST = '127.0.0.1';
const UNAUTHORIZED = 4401;
/**
 * Clients send the token as the WebSocket subprotocol `threadgarden.<token>`;
 * `pahub.<token>` (clients before v1.3) is accepted too, for one release
 * (spec v1.3 §9).
 */
const PROTOCOL_PREFIXES = ['threadgarden.', 'pahub.'] as const;

/** The token a subprotocol carries, or null for one that is not ours. */
const tokenOf = (protocol: string): string | null => {
  const prefix = PROTOCOL_PREFIXES.find((p) => protocol.startsWith(p));
  return prefix === undefined ? null : protocol.slice(prefix.length);
};

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
  /** A server or dispatch failure after startup; the server keeps serving. */
  onError?: (err: unknown) => void;
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
    maxPayload: MAX_REQUEST_BYTES,
    // Echo the first offered subprotocol of ours so browsers complete the
    // handshake; the token is verified on connection.
    handleProtocols: (protocols) => [...protocols].find((p) => tokenOf(p) !== null) ?? false,
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (err: unknown): void => reject(err);
    wss.once('error', failed);
    wss.once('listening', () => {
      wss.off('error', failed);
      resolve();
    });
  });
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Nothing left to tell.
    }
  };
  // An 'error' event without a listener throws; after listening, errors are reported.
  wss.on('error', report);

  const send = (ws: WebSocket, msg: Response | EventMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws) => {
    const offered = tokenOf(ws.protocol);
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
      const { id } = req;
      void opts.router
        .dispatch(req, { clientId })
        .catch((err: unknown): Response => {
          report(err);
          return { id, error: { code: 'INTERNAL', message: 'Internal error' } };
        })
        .then((res) => send(ws, res))
        .catch(report);
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

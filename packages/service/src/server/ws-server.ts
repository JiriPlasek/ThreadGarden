import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_REQUEST_BYTES, RELAY_CLOSE, type EventMsg } from '@threadgarden/protocol';
import { dropOnError, sendFrame, serveFrames } from './frames.js';
import type { Relay } from './relay.js';
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

/** `/relay?machine=<id>`: the paired machine to relay to (null: none named); otherwise not a relay. */
const relayTarget = (url: string | undefined): { machineId: string | null } | null => {
  const parsed = new URL(url ?? '/', 'http://127.0.0.1');
  return parsed.pathname === '/relay' ? { machineId: parsed.searchParams.get('machine') } : null;
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
  /** Paired machines (`/relay`); without it a relay is closed 4404. */
  relay?: Pick<Relay, 'attach'>;
  /** Connected clients, relays included (they keep the service from its idle exit). */
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

  /** UI sockets relayed to paired machines: counted as clients, never sent local events. */
  const relays = new Set<WebSocket>();
  const counted = (): void => opts.onClientCountChange(clients.size + relays.size);

  wss.on('connection', (ws, req) => {
    dropOnError(ws, report);
    const offered = tokenOf(ws.protocol);
    if (offered === null || !tokenMatches(offered, opts.token)) {
      ws.close(UNAUTHORIZED, 'unauthorized');
      return;
    }
    let relay: { machineId: string | null } | null;
    try {
      relay = relayTarget(req.url);
    } catch {
      // A path no URL parser takes is not `/relay`: served as before.
      relay = null;
    }
    if (relay) {
      if (!opts.relay) {
        ws.close(RELAY_CLOSE.locked, 'no paired machines here');
        return;
      }
      relays.add(ws);
      counted();
      ws.on('close', () => {
        relays.delete(ws);
        counted();
      });
      try {
        opts.relay.attach(ws, relay.machineId);
      } catch (err) {
        report(err);
        ws.close(1011, 'internal error');
      }
      return;
    }
    clients.add(ws);
    counted();
    serveFrames(ws, {
      router: opts.router,
      ctx: { clientId: randomUUID(), origin: 'local' },
      report,
    });
    ws.on('close', () => {
      clients.delete(ws);
      counted();
    });
  });

  const addr = wss.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected server address');

  return {
    port: addr.port,
    address: addr.address,
    broadcast: (e) => {
      for (const ws of clients) sendFrame(ws, e);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
};

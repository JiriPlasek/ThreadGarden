import { mkdtemp } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadOrCreateTlsIdentity, type TlsIdentity } from '../../src/machine/tls.js';

/**
 * A TLS WebSocket server with a certificate of its own: an impostor at a
 * paired machine's address, or a peer under the test's control. It records
 * every TLS handshake, every upgrade request and every frame it receives.
 */
export type FakeMachine = {
  port: number;
  tls: TlsIdentity;
  /** Headers of every upgrade request (none may arrive when the pin does not match). */
  upgradeRequests(): IncomingHttpHeaders[];
  /** TCP connections accepted. */
  connections(): number;
  /** TLS handshakes clients completed. */
  handshakes(): number;
  /** Every frame received, as sent. */
  received(): { data: string; binary: boolean }[];
  /** The params of every request for `method`. */
  calls(method: string): unknown[];
  /** Sockets that were closed (by either side). */
  closed(): number;
  close(): Promise<void>;
};

export const startFakeMachine = async (
  dir: string,
  onSocket: (ws: WebSocket, protocol: string) => void = () => {},
  /** `autoPong: false`: pings go unanswered, like a machine whose network dropped. */
  opts: { autoPong?: boolean; tls?: TlsIdentity } = {},
): Promise<FakeMachine> => {
  const tls =
    opts.tls ?? (await loadOrCreateTlsIdentity(await mkdtemp(join(dir, 'fake-')), 'impostor'));
  const upgrades: IncomingHttpHeaders[] = [];
  const frames: { data: string; binary: boolean }[] = [];
  let connections = 0;
  let handshakes = 0;
  let closed = 0;
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
    autoPong: opts.autoPong ?? true,
  });
  const https = createServer({ key: tls.keyPem, cert: tls.certPem });
  https.on('connection', () => connections++);
  https.on('secureConnection', () => handshakes++);
  // A client that aborts its handshake (a pin mismatch) resets the connection.
  https.on('tlsClientError', () => {});
  https.on('upgrade', (req, socket, head) => {
    upgrades.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data, binary) => frames.push({ data: String(data), binary }));
      ws.on('close', () => closed++);
      onSocket(ws, ws.protocol);
    });
  });
  const port = await new Promise<number>((resolve) =>
    https.listen(0, '127.0.0.1', () => resolve((https.address() as AddressInfo).port)),
  );
  const calls = (method: string): unknown[] =>
    frames.flatMap((f) => {
      try {
        const msg = JSON.parse(f.data) as { method?: string; params?: unknown };
        return msg.method === method ? [msg.params] : [];
      } catch {
        return [];
      }
    });
  return {
    port,
    tls,
    upgradeRequests: () => [...upgrades],
    connections: () => connections,
    handshakes: () => handshakes,
    received: () => [...frames],
    calls,
    closed: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        https.close(() => resolve());
        https.closeAllConnections();
      }),
  };
};

/** Answers each JSON request on `ws` with `answer(method, params)` (`{ result }` or `{ error }`). */
export const answerRequests = (
  ws: WebSocket,
  answer: (method: string, params: unknown) => object,
): void => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
    ws.send(JSON.stringify({ id: msg.id, ...answer(msg.method, msg.params) }));
  });
};

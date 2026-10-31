import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_REQUEST_BYTES, type Device, type EventMsg } from '@threadgarden/protocol';
import type { DeviceRegistry } from '../machine/devices.js';
import type { TlsIdentity } from '../machine/tls.js';
import { dropOnError, sendFrame, serveFrames } from './frames.js';
import type { Router } from './router.js';

/** The remote listener's port unless told otherwise. */
export const REMOTE_PORT = 47380;

const UNAUTHORIZED = 4401;
const REVOKED = 4403;
const INTERNAL_ERROR = 1011;
/** A paired device: `threadgarden-device.<token>`, the full protocol. */
const DEVICE_PREFIX = 'threadgarden-device.';
/** A device being paired: only the methods below, no events. */
const PAIR_PROTOCOL = 'threadgarden-pair';
const PAIR_METHODS: ReadonlySet<string> = new Set(['hello', 'pair.proof', 'pair.claim']);

const isOurs = (p: string): boolean => p === PAIR_PROTOCOL || p.startsWith(DEVICE_PREFIX);

/** One address's TLS server; its WebSocket server attaches once it listens. */
type Listener = { https: Server; wss?: WebSocketServer };

const listen = (server: Server, port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const failed = (err: unknown): void => reject(err);
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) reject(new Error('unexpected server address'));
      else resolve(addr.port);
    });
  });

const shut = ({ https, wss }: Listener): Promise<void> =>
  new Promise((resolve) => {
    const closeHttps = (): void => {
      // Called back with an error when it never listened; closed either way.
      https.close(() => resolve());
      // Idle TLS connections that never upgraded would hold close() open.
      https.closeAllConnections();
    };
    if (!wss) return closeHttps();
    for (const ws of wss.clients) ws.terminate();
    wss.close(closeHttps);
  });

/**
 * The network-facing listener for paired devices and devices being paired:
 * one TLS server per given address, all on one port. It does not filter the
 * addresses (main.ts passes private ones only). Until a socket is
 * authenticated by its subprotocol no method runs.
 */
export const startRemoteServer = async (opts: {
  addresses: string[];
  port: number;
  tls: TlsIdentity;
  devices: DeviceRegistry;
  router: Router;
  /** Paired devices connected now; pairing sockets are not counted. */
  onClientCountChange(n: number): void;
  /** A server or dispatch failure after startup; the server keeps serving. */
  onError?(err: unknown): void;
}): Promise<{
  addresses: string[];
  port: number;
  broadcast(e: EventMsg): void;
  close(): Promise<void>;
}> => {
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Nothing left to tell.
    }
  };
  /** Each paired device's open sockets (event targets; closed on revoke). */
  const devices = new Map<WebSocket, string>();

  const onConnection = (ws: WebSocket): void => {
    dropOnError(ws);
    if (ws.protocol === PAIR_PROTOCOL) {
      serveFrames(ws, {
        router: opts.router,
        ctx: { clientId: randomUUID(), origin: 'remote' },
        allows: (m) => PAIR_METHODS.has(m),
        report,
      });
      return;
    }
    let device: Device | null;
    try {
      device = ws.protocol.startsWith(DEVICE_PREFIX)
        ? opts.devices.verify(ws.protocol.slice(DEVICE_PREFIX.length))
        : null;
      if (device) opts.devices.touch(device.id);
    } catch (err) {
      // The registry failed (its database): refuse this socket, keep the service.
      report(err);
      ws.close(INTERNAL_ERROR, 'internal error');
      return;
    }
    if (!device) {
      ws.close(UNAUTHORIZED, 'unauthorized');
      return;
    }
    devices.set(ws, device.id);
    opts.onClientCountChange(devices.size);
    serveFrames(ws, {
      router: opts.router,
      ctx: { clientId: randomUUID(), origin: 'remote', deviceId: device.id },
      report,
    });
    ws.on('close', () => {
      devices.delete(ws);
      opts.onClientCountChange(devices.size);
    });
  };

  const listeners: Listener[] = [];
  let port = opts.port;
  try {
    for (const address of opts.addresses) {
      const https = createServer({ key: opts.tls.keyPem, cert: opts.tls.certPem }, (_req, res) => {
        res.writeHead(426, { Connection: 'close', Upgrade: 'websocket' }).end();
      });
      const listener: Listener = { https };
      listeners.push(listener);
      // The first address picks the port (0 = any free one); the others share it.
      port = await listen(https, port, address);
      // Attached only now: it re-emits the server's errors, and a listen
      // failure must reject above rather than throw from an unheard 'error'.
      const wss = new WebSocketServer({
        server: https,
        maxPayload: MAX_REQUEST_BYTES,
        // Only our subprotocols are negotiated; the token is verified on connection.
        handleProtocols: (protocols) => [...protocols].find(isOurs) ?? false,
      });
      listener.wss = wss;
      // After listening, errors are reported; the server keeps serving.
      wss.on('error', report);
      wss.on('connection', onConnection);
    }
  } catch (err) {
    await Promise.all(listeners.map(shut));
    throw err;
  }

  const unsubscribe = opts.devices.onRevoke((deviceId) => {
    for (const [ws, id] of devices) if (id === deviceId) ws.close(REVOKED, 'revoked');
  });

  return {
    addresses: [...opts.addresses],
    port,
    broadcast: (e) => {
      for (const ws of devices.keys()) sendFrame(ws, e);
    },
    close: async () => {
      unsubscribe();
      await Promise.all(listeners.map(shut));
    },
  };
};

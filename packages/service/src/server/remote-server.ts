import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import { BlockList, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_REQUEST_BYTES, type EventMsg } from '@threadgarden/protocol';
import type { DeviceRegistry } from '../machine/devices.js';
import type { TlsIdentity } from '../machine/tls.js';
import { dropOnError, sendFrame, serveFrames } from './frames.js';
import type { Router } from './router.js';

/** The remote listener's port unless told otherwise. */
export const REMOTE_PORT = 47380;
/** Largest frame a socket that is not a verified device may send (pairing requests are tiny). */
export const PAIRING_MAX_PAYLOAD = 4096;
/** Pairing sockets open at once; more are refused with HTTP 503. */
export const PAIRING_MAX_SOCKETS = 4;
/** A pairing socket is closed after this long, paired or not. */
export const PAIRING_SOCKET_TTL_MS = 60_000;
/** TCP connections each address's server holds at once (TLS handshakes included); more are dropped. */
export const REMOTE_MAX_CONNECTIONS = 64;
/**
 * A TLS handshake not finished by then closes its connection, so idle TCP
 * connections cannot hold the `REMOTE_MAX_CONNECTIONS` slots (Node's default: 120 s).
 */
export const REMOTE_HANDSHAKE_TIMEOUT_MS = 10_000;

const UNAUTHORIZED = 4401;
const REVOKED = 4403;
const PAIRING_TIMEOUT = 4408;
const INTERNAL_ERROR = 1011;
/** A paired device: `threadgarden-device.<token>`, the full protocol. */
const DEVICE_PREFIX = 'threadgarden-device.';
/** A device being paired: only the methods below, no events. */
const PAIR_PROTOCOL = 'threadgarden-pair';
const PAIR_METHODS: ReadonlySet<string> = new Set(['hello', 'pair.proof', 'pair.claim']);

const isOurs = (p: string): boolean => p === PAIR_PROTOCOL || p.startsWith(DEVICE_PREFIX);
/** The first subprotocol of ours the client offers, if any. */
const offeredProtocol = (req: IncomingMessage): string | undefined =>
  req.headers['sec-websocket-protocol']
    ?.split(',')
    .map((p) => p.trim())
    .find(isOurs);

const UNSPECIFIED = new BlockList();
UNSPECIFIED.addAddress('0.0.0.0', 'ipv4');
UNSPECIFIED.addAddress('::', 'ipv6');
/** An IP literal that names one interface: never empty, a host name or a wildcard. */
const isSpecificAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 0) return false;
  return !UNSPECIFIED.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

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

/** Each server's TCP connections from accept on, TLS handshakes included. */
const accepted = new WeakMap<Server, Set<Socket>>();
const trackConnections = (https: Server): void => {
  const sockets = new Set<Socket>();
  accepted.set(https, sockets);
  https.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
};

const closeHttps = (https: Server): Promise<void> =>
  new Promise((resolve) => {
    // Called back with an error when it never listened; closed either way.
    https.close(() => resolve());
    // Idle TLS connections that never upgraded would hold close() open.
    https.closeAllConnections();
    // So would one still in its TLS handshake, which closeAllConnections does not see.
    for (const socket of accepted.get(https) ?? []) socket.destroy();
  });

const closeWss = (wss: WebSocketServer): Promise<void> =>
  new Promise((resolve) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => resolve());
  });

/**
 * The network-facing listener for paired devices and devices being paired:
 * one TLS server per given address, all on one port. It does not filter
 * private addresses (main.ts passes private ones only) but refuses wildcards.
 *
 * Upgrades are routed before any WebSocket exists: a device token is verified
 * first and only a verified device reaches the full-size server; everything
 * else (pairing, a bad or missing credential) gets the small one, where a bad
 * credential is closed with 4401 at once. No method runs before that.
 */
export const startRemoteServer = async (opts: {
  addresses: string[];
  port: number;
  tls: TlsIdentity;
  devices: DeviceRegistry;
  router: Router;
  /** Paired devices connected now; pairing sockets are not counted. */
  onClientCountChange(n: number): void;
  /**
   * A failure after startup; the server keeps serving. `peer`: a socket error
   * any peer can cause (a broken or oversized frame); `service`: everything
   * else (the registry, a dispatch, the pairing check, the server itself).
   */
  onError?(err: unknown, kind: 'peer' | 'service'): void;
  /**
   * Whether pairing sockets are admitted now (default: always). main.ts admits
   * them only while a pairing code is live; otherwise they are refused with 503.
   */
  pairingOpen?(): boolean;
  /** Tests: how long a pairing socket stays open (default `PAIRING_SOCKET_TTL_MS`). */
  pairingTtlMs?: number;
  /** Tests: the TLS handshake timeout (default `REMOTE_HANDSHAKE_TIMEOUT_MS`). */
  handshakeTimeoutMs?: number;
}): Promise<{
  addresses: string[];
  port: number;
  broadcast(e: EventMsg): void;
  close(): Promise<void>;
}> => {
  for (const address of opts.addresses) {
    if (!isSpecificAddress(address))
      throw new Error(`refusing to listen on ${JSON.stringify(address)}: not one interface`);
  }
  const tell = (err: unknown, kind: 'peer' | 'service'): void => {
    try {
      opts.onError?.(err, kind);
    } catch {
      // Nothing left to tell.
    }
  };
  const report = (err: unknown): void => tell(err, 'service');
  const reportPeer = (err: unknown): void => tell(err, 'peer');
  const pairingTtlMs = opts.pairingTtlMs ?? PAIRING_SOCKET_TTL_MS;
  /** Each paired device's open sockets (event targets; closed on revoke). */
  const deviceSockets = new Map<WebSocket, string>();
  const pairingSockets = new Set<WebSocket>();

  const handleProtocols = (protocols: Set<string>): string | false =>
    [...protocols].find(isOurs) ?? false;
  const deviceWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REQUEST_BYTES,
    handleProtocols,
  });
  const smallWss = new WebSocketServer({
    noServer: true,
    maxPayload: PAIRING_MAX_PAYLOAD,
    handleProtocols,
  });

  const refuse = (ws: WebSocket, code: number, reason: string): void => {
    dropOnError(ws, reportPeer);
    ws.close(code, reason);
  };

  const onDevice = (ws: WebSocket, token: string, deviceId: string): void => {
    dropOnError(ws, reportPeer);
    try {
      // Verified again: a revoke between the upgrade and now must still count.
      if (opts.devices.verify(token)?.id !== deviceId) {
        ws.close(REVOKED, 'revoked');
        return;
      }
      opts.devices.touch(deviceId);
    } catch (err) {
      report(err);
      ws.close(INTERNAL_ERROR, 'internal error');
      return;
    }
    deviceSockets.set(ws, deviceId);
    opts.onClientCountChange(deviceSockets.size);
    serveFrames(ws, {
      router: opts.router,
      ctx: { clientId: randomUUID(), origin: 'remote', deviceId },
      report,
    });
    ws.on('close', () => {
      deviceSockets.delete(ws);
      opts.onClientCountChange(deviceSockets.size);
    });
  };

  const onPairing = (ws: WebSocket): void => {
    dropOnError(ws, reportPeer);
    pairingSockets.add(ws);
    const timer = setTimeout(() => ws.close(PAIRING_TIMEOUT, 'pairing timed out'), pairingTtlMs);
    timer.unref?.();
    ws.on('close', () => {
      clearTimeout(timer);
      pairingSockets.delete(ws);
    });
    serveFrames(ws, {
      router: opts.router,
      ctx: { clientId: randomUUID(), origin: 'remote' },
      allows: (m) => PAIR_METHODS.has(m),
      report,
    });
  };

  /** Pairing is admitted while it is open and below the socket cap; a failing check refuses it. */
  const pairingAdmitted = (): boolean => {
    if (pairingSockets.size >= PAIRING_MAX_SOCKETS) return false;
    try {
      return opts.pairingOpen?.() ?? true;
    } catch (err) {
      report(err);
      return false;
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const protocol = offeredProtocol(req);
    if (protocol?.startsWith(DEVICE_PREFIX)) {
      const token = protocol.slice(DEVICE_PREFIX.length);
      let deviceId: string | undefined;
      try {
        deviceId = opts.devices.verify(token)?.id;
      } catch (err) {
        // The registry failed (its database): refuse this socket, keep the service.
        report(err);
        smallWss.handleUpgrade(req, socket, head, (ws) =>
          refuse(ws, INTERNAL_ERROR, 'internal error'),
        );
        return;
      }
      if (deviceId !== undefined) {
        const id = deviceId;
        deviceWss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, token, id));
        return;
      }
    } else if (protocol === PAIR_PROTOCOL) {
      if (!pairingAdmitted()) {
        socket.on('error', () => socket.destroy());
        socket.once('finish', () => socket.destroy());
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      smallWss.handleUpgrade(req, socket, head, onPairing);
      return;
    }
    // A wrong, missing or foreign credential: upgraded only to be closed.
    smallWss.handleUpgrade(req, socket, head, (ws) => refuse(ws, UNAUTHORIZED, 'unauthorized'));
  };

  const servers: Server[] = [];
  let port = opts.port;
  try {
    for (const address of opts.addresses) {
      const https = createServer(
        {
          key: opts.tls.keyPem,
          cert: opts.tls.certPem,
          handshakeTimeout: opts.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS,
        },
        (_req, res) => {
          res.writeHead(426, { Connection: 'close', Upgrade: 'websocket' }).end();
        },
      );
      https.maxConnections = REMOTE_MAX_CONNECTIONS;
      trackConnections(https);
      https.on('upgrade', onUpgrade);
      servers.push(https);
      // The first address picks the port (0 = any free one); the others share it.
      port = await listen(https, port, address);
      // After listening, errors are reported; the server keeps serving.
      https.on('error', report);
    }
  } catch (err) {
    await Promise.all([closeWss(deviceWss), closeWss(smallWss), ...servers.map(closeHttps)]);
    throw err;
  }

  const unsubscribe = opts.devices.onRevoke((deviceId) => {
    for (const [ws, id] of deviceSockets) if (id === deviceId) ws.close(REVOKED, 'revoked');
  });

  return {
    addresses: [...opts.addresses],
    port,
    broadcast: (e) => {
      for (const ws of deviceSockets.keys()) sendFrame(ws, e);
    },
    close: async () => {
      unsubscribe();
      await Promise.all([closeWss(deviceWss), closeWss(smallWss)]);
      await Promise.all(servers.map(closeHttps));
    },
  };
};

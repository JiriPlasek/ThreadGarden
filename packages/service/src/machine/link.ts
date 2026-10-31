import { X509Certificate } from 'node:crypto';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';

/** A paired machine's certificate as pinned at pairing. */
export type Pin = { certPem: string; fingerprint: string };
/** The certificate a peer presented. */
export type PeerCertificate = { certPem: string; fingerprint: string };

/**
 * Why a link never opened: `pin` the peer's certificate is not the pinned one
 * (the TLS handshake failed it; nothing was sent); `refused` the peer answered
 * the upgrade with an HTTP status; `unreachable` everything else (no route, no
 * listener, a reset, the time ran out).
 */
export class LinkError extends Error {
  constructor(
    readonly kind: 'pin' | 'unreachable' | 'refused',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

/** `wss://` URL of a machine's listener; IPv6 literals in brackets. */
const linkUrl = (address: string, port: number): string =>
  `wss://${isIP(address) === 6 ? `[${address}]` : address}:${port}/`;

const PIN_MISMATCH = 'PIN_MISMATCH';

/**
 * A WebSocket to another machine's listener over TLS. The TLS connection is
 * made here, and handed to the HTTP client only once its handshake succeeded:
 * with a `pin`, the certificate must chain to the pinned one (`ca`) and carry
 * its fingerprint (`checkServerIdentity`), so to a peer with any other
 * certificate the upgrade request (and the token in its subprotocol) is never
 * written. Without a pin any certificate is taken (pairing); `opened` tells
 * which.
 *
 * Listeners go on `ws` at once (nothing is missed); `opened` settles when it
 * opens, or rejects with a `LinkError` when it never does within `timeoutMs`.
 * Throws a `LinkError` at once for an address no URL can carry.
 */
export const openLink = (opts: {
  address: string;
  port: number;
  protocol: string;
  pin?: Pin;
  timeoutMs: number;
  /** Largest frame accepted from the peer (default ws's 100 MiB). */
  maxPayload?: number;
}): { ws: WebSocket; opened: Promise<PeerCertificate> } => {
  let failure: LinkError | undefined;
  let peer: PeerCertificate | undefined;
  /** The TLS socket until it is handed over: destroyed when the link gives up first. */
  let handshaking: TLSSocket | undefined;
  const fail = (err: LinkError): void => {
    failure ??= err;
  };
  const tlsOptions = (host: string): ConnectionOptions => ({
    host,
    // SNI only for host names; Node refuses an IP address as a server name.
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(opts.pin
      ? {
          ca: [opts.pin.certPem],
          checkServerIdentity: (_host, cert) =>
            cert.fingerprint256 === opts.pin!.fingerprint ? undefined : new Error(PIN_MISMATCH),
        }
      : { rejectUnauthorized: false }),
  });
  const createConnection = (
    options: { host?: string; port?: number | string },
    done: (err: Error | null, socket?: Duplex) => void,
  ): undefined => {
    let handedOver = false;
    const host = options.host ?? opts.address;
    const socket: TLSSocket = connect({ ...tlsOptions(host), port: Number(options.port) });
    handshaking = socket;
    socket.on('error', (err) => {
      if (handedOver) return;
      // Set only when the certificate failed verification (chain or pin).
      if (socket.authorizationError !== undefined && socket.authorizationError !== null) {
        fail(new LinkError('pin', 'the machine presented another certificate'));
      } else {
        fail(new LinkError('unreachable', err.message));
      }
      done(err);
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      const fingerprint = cert?.fingerprint256;
      // Verified by the handshake already; checked again before a byte is written.
      if (!cert?.raw || (opts.pin && fingerprint !== opts.pin.fingerprint)) {
        fail(new LinkError('pin', 'the machine presented another certificate'));
        socket.destroy();
        done(new Error(PIN_MISMATCH));
        return;
      }
      peer = { certPem: new X509Certificate(cert.raw).toString(), fingerprint };
      handedOver = true;
      handshaking = undefined;
      done(null, socket);
    });
    return undefined;
  };

  let ws: WebSocket;
  try {
    ws = new WebSocket(linkUrl(opts.address, opts.port), [opts.protocol], {
      // Node's HTTP client also takes a socket handed over later through the callback.
      createConnection: createConnection as unknown as (o: object) => Socket,
      perMessageDeflate: false,
      ...(opts.maxPayload === undefined ? {} : { maxPayload: opts.maxPayload }),
    });
  } catch {
    // An address the URL cannot carry, or a protocol the header cannot (never the token itself).
    throw new LinkError('unreachable', 'not a valid address');
  }
  // Errors also end in 'close'; without a listener ws would throw them.
  ws.on('error', (err) => fail(new LinkError('unreachable', err.message)));
  ws.on('unexpected-response', (_req, res) => {
    fail(new LinkError('refused', `HTTP ${res.statusCode}`, res.statusCode));
    res.resume();
    ws.terminate();
  });
  const opened = new Promise<PeerCertificate>((resolve, reject) => {
    const timer = setTimeout(() => {
      fail(new LinkError('unreachable', 'timed out'));
      ws.terminate();
    }, opts.timeoutMs);
    timer.unref?.();
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(peer!);
    });
    ws.once('close', () => {
      clearTimeout(timer);
      // Given up during the handshake (timeout, terminate): the peer must not hold the socket.
      handshaking?.destroy();
      reject(failure ?? new LinkError('unreachable', 'closed'));
    });
  });
  // A caller that only listens on `ws` must not get an unhandled rejection.
  opened.catch(() => {});
  return { ws, opened };
};

type Reply = { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

/** An error answer from the other machine. */
export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

let nextId = 1;
/**
 * One request over an open link: the result, or a `RemoteError` with the
 * peer's code, or a `LinkError` when the link closes or `timeoutMs` passes
 * first. Events and other replies are skipped.
 */
export const request = (
  ws: WebSocket,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (ws.readyState !== ws.OPEN) {
      reject(new LinkError('unreachable', `link closed before ${method}`));
      return;
    }
    const id = nextId++;
    const done = (): void => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    const onMessage = (data: unknown): void => {
      let msg: Reply;
      try {
        msg = JSON.parse(String(data)) as Reply;
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object' || msg.id !== id) return;
      done();
      if (msg.error) {
        const code = typeof msg.error.code === 'string' ? msg.error.code : 'INTERNAL';
        const message = typeof msg.error.message === 'string' ? msg.error.message : code;
        reject(new RemoteError(code, message));
      } else resolve(msg.result);
    };
    const onClose = (): void => {
      done();
      reject(new LinkError('unreachable', `closed during ${method}`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new LinkError('unreachable', `${method} timed out`));
    }, timeoutMs);
    timer.unref?.();
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.send(JSON.stringify({ id, method, params }));
  });

import { MAX_REQUEST_BYTES, RELAY_CLOSE } from '@threadgarden/protocol';
import type { RawData, WebSocket } from 'ws';
import { LinkError, openLink } from '../machine/link.js';
import type { StoredMachine } from '../machine/paired-machines.js';
import { DEVICE_PROTOCOL_PREFIX } from '../machine/pairing-client.js';

/** How long a relay waits for its link to the machine before closing the UI socket 4502. */
export const RELAY_LINK_TIMEOUT_MS = 10_000;
/**
 * How often an open link is pinged. A link whose pong has not come back by
 * the next ping is dead (a Wi-Fi drop sends no close): it is terminated and
 * the UI socket closed 4502, so the UI reconnects.
 */
export const RELAY_PING_MS = 15_000;

/** The remote listener's close codes for a token it refuses: unknown (4401) and revoked (4403). */
const REMOTE_REFUSED: ReadonlySet<number> = new Set([4401, 4403]);

/**
 * What the UI is told when an open link closes: a refused token is `refused`
 * (4403: stop, pair again); anything else, a clean close (1000, 1001)
 * included, is `unreachable` (4502: the UI reconnects with backoff).
 */
export const relayCloseFor = (remoteCode: number): number =>
  REMOTE_REFUSED.has(remoteCode) ? RELAY_CLOSE.refused : RELAY_CLOSE.unreachable;

/** What the UI is told when the link never opened. */
const failureCode = (err: unknown): number => {
  if (err instanceof LinkError && err.kind === 'pin') return RELAY_CLOSE.mismatch;
  if (
    err instanceof LinkError &&
    err.kind === 'refused' &&
    (err.status === 401 || err.status === 403)
  )
    return RELAY_CLOSE.refused;
  return RELAY_CLOSE.unreachable;
};

const REASONS: Record<number, string> = {
  [RELAY_CLOSE.locked]: 'unknown or locked machine',
  [RELAY_CLOSE.mismatch]: 'another certificate answered at this address',
  [RELAY_CLOSE.refused]: 'the machine refused this device',
  [RELAY_CLOSE.unreachable]: 'the machine cannot be reached',
};

const byteLength = (data: RawData): number =>
  Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;

export type Relay = {
  /** Relays an authenticated UI socket (`/relay?machine=<id>`) to the machine. */
  attach(ui: WebSocket, machineId: string | null): void;
  /** Closes the machine's relays with `code` (it moved, or it was removed). */
  drop(machineId: string, code: number): void;
  /** Closes every relay and its link (the service stops). */
  close(): void;
};

/**
 * The local end of the UI's connections to paired machines. Each UI socket
 * gets its own link (`openLink`: TLS pinned to the machine's certificate,
 * the device token in the subprotocol) and the two are piped: frames go
 * through verbatim both ways, text as text and binary as binary, and are
 * never parsed, logged or rewritten. Frames the UI sends before the link is
 * up wait for it. Either side closing closes the other; the UI learns why
 * through `RELAY_CLOSE` codes.
 */
export const createRelay = (deps: {
  machines: { get(id: string): StoredMachine | null; token(id: string): string | null };
  /** Default `RELAY_LINK_TIMEOUT_MS`. */
  linkTimeoutMs?: number;
  /** Default `RELAY_PING_MS`. */
  pingMs?: number;
  /**
   * A link that never opened or stopped answering pings (for a debug log: the
   * machine and why, never a frame or token).
   */
  onLinkFailed?: (machineId: string, err: unknown) => void;
}): Relay => {
  const relays = new Map<WebSocket, { machineId: string; end(code: number): void }>();
  /** Set by `close()`: the service is stopping, no new links. */
  let closed = false;
  const pingMs = deps.pingMs ?? RELAY_PING_MS;

  const attach = (ui: WebSocket, machineId: string | null): void => {
    if (closed) {
      ui.close(1001, 'shutting down');
      return;
    }
    const machine = machineId === null ? null : deps.machines.get(machineId);
    const token = machine ? deps.machines.token(machine.id) : null;
    if (!machine || token === null) {
      ui.close(RELAY_CLOSE.locked, REASONS[RELAY_CLOSE.locked]);
      return;
    }
    let link: ReturnType<typeof openLink>;
    try {
      link = openLink({
        address: machine.address,
        port: machine.port,
        protocol: `${DEVICE_PROTOCOL_PREFIX}${token}`,
        pin: { certPem: machine.certPem, fingerprint: machine.fingerprint },
        timeoutMs: deps.linkTimeoutMs ?? RELAY_LINK_TIMEOUT_MS,
      });
    } catch (err) {
      deps.onLinkFailed?.(machine.id, err);
      ui.close(RELAY_CLOSE.unreachable, REASONS[RELAY_CLOSE.unreachable]);
      return;
    }
    const { ws: remote, opened } = link;
    let linked = false;
    let ended = false;
    const waiting: { data: RawData; binary: boolean }[] = [];
    let waitingBytes = 0;
    let pinger: ReturnType<typeof setInterval> | undefined;

    const end = (code: number): void => {
      if (ended) return;
      ended = true;
      clearInterval(pinger);
      relays.delete(ui);
      waiting.length = 0;
      ui.close(code, REASONS[code] ?? '');
      if (remote.readyState === remote.OPEN) remote.close(1000);
      else remote.terminate();
    };
    relays.set(ui, { machineId: machine.id, end });

    ui.on('message', (data, binary) => {
      if (ended) return;
      if (linked) {
        remote.send(data, { binary });
        return;
      }
      waitingBytes += byteLength(data);
      // The UI does not send this much before the link is up; bounded all the same.
      if (waitingBytes > MAX_REQUEST_BYTES) end(1009);
      else waiting.push({ data, binary });
    });
    ui.on('close', () => end(1000));

    remote.on('open', () => {
      if (ended) return;
      linked = true;
      for (const f of waiting.splice(0)) remote.send(f.data, { binary: f.binary });
      waitingBytes = 0;
      let answered = true;
      remote.on('pong', () => {
        answered = true;
      });
      pinger = setInterval(() => {
        if (!answered) {
          deps.onLinkFailed?.(machine.id, new Error('no pong: the link is dead'));
          remote.terminate();
          end(RELAY_CLOSE.unreachable);
          return;
        }
        answered = false;
        remote.ping();
      }, pingMs);
      pinger.unref?.();
    });
    remote.on('message', (data, binary) => {
      if (ui.readyState === ui.OPEN) ui.send(data, { binary });
    });
    // Before it opened, `opened` says why it failed.
    remote.on('close', (code) => {
      if (linked) end(relayCloseFor(code));
    });
    opened.catch((err: unknown) => {
      if (!ended) deps.onLinkFailed?.(machine.id, err);
      end(failureCode(err));
    });
  };

  return {
    attach,
    drop: (machineId, code) => {
      for (const r of [...relays.values()]) if (r.machineId === machineId) r.end(code);
    },
    close: () => {
      closed = true;
      for (const r of [...relays.values()]) r.end(1001);
    },
  };
};

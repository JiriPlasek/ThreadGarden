import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DeviceTokenSchema, methods, type MachineInfo } from '@threadgarden/protocol';
import { ServiceError } from '../server/router.js';
import { isWellFormedPairingCode, normalisePairingCode, pairingProof } from './devices.js';
import { LinkError, RemoteError, openLink, request, type Pin } from './link.js';

/** The subprotocol of a device being paired, and of a paired one (followed by its token). */
export const PAIR_PROTOCOL = 'threadgarden-pair';
export const DEVICE_PROTOCOL_PREFIX = 'threadgarden-device.';
/** How long pairing may take in all (connecting, proof and claim). */
export const PAIRING_TIMEOUT_MS = 10_000;
/** How long removing a machine waits for it to revoke this device. */
export const UNPAIR_TIMEOUT_MS = 5_000;
/** Largest frame taken from a machine being paired: its answers are small. */
const PAIRING_MAX_FRAME = 64 * 1024;
/** The remote listener closes a socket whose token was revoked with this code. */
const REVOKED = 4403;

export type PairingErrorCode =
  'PAIRING_UNREACHABLE' | 'PAIRING_PROOF_FAILED' | 'PAIRING_INVALID' | 'PAIRING_EXPIRED';

const MESSAGES: Record<PairingErrorCode, string> = {
  PAIRING_UNREACHABLE: 'The machine could not be reached',
  PAIRING_PROOF_FAILED:
    'The machine could not prove it knows the pairing code; the code was not sent',
  PAIRING_INVALID: 'The pairing code is not valid',
  PAIRING_EXPIRED: 'The pairing code has expired',
};
const pairingError = (code: PairingErrorCode): ServiceError =>
  new ServiceError(code, MESSAGES[code]);

/** Compares two hex digests in constant time (equal lengths first: timingSafeEqual needs them). */
const sameDigest = (expected: string, actual: string | null): boolean => {
  if (actual === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A link failure, or the machine refusing pairing sockets (503: no code is out, or it is busy). */
const notConnected = (err: unknown): ServiceError =>
  pairingError(
    err instanceof LinkError && err.kind === 'refused' && err.status === 503
      ? 'PAIRING_INVALID'
      : 'PAIRING_UNREACHABLE',
  );

const closeNow = (ws: {
  readyState: number;
  OPEN: number;
  close(c: number): void;
  terminate(): void;
}): void => {
  if (ws.readyState === ws.OPEN) ws.close(1000);
  else ws.terminate();
};

/**
 * Pairs this machine, as a device called `deviceName`, with the machine at
 * `address:port` that shows `code` (ledger Ruling R7):
 *
 * 1. connects on the pairing subprotocol, taking any certificate, and notes
 *    the one presented;
 * 2. sends `pair.proof` with a fresh random nonce only (never the code) and
 *    checks the answer against HMAC(code, fingerprint seen + nonce) computed
 *    here: a machine that does not know the code, or a man in the middle
 *    with another certificate relaying the real machine's proof, fails it;
 * 3. `accept` may refuse the machine now (this machine itself, one already
 *    paired), still before the code is sent;
 * 4. only then sends the code with `pair.claim`.
 *
 * The pairing socket is closed as soon as this is done, whatever the outcome
 * (the machine has few pairing slots). The certificate returned is the one to
 * pin. Errors are `ServiceError`s: `PAIRING_UNREACHABLE`,
 * `PAIRING_PROOF_FAILED`, `PAIRING_INVALID`, `PAIRING_EXPIRED`, or whatever
 * `accept` throws.
 */
export const pairWithMachine = async (opts: {
  address: string;
  port: number;
  code: string;
  deviceName: string;
  timeoutMs?: number;
  accept?: (machine: MachineInfo) => void;
}): Promise<{
  machine: MachineInfo;
  deviceId: string;
  certPem: string;
  fingerprint: string;
  token: string;
}> => {
  // A code that cannot be one is refused here: nothing to prove, nothing to send.
  if (!isWellFormedPairingCode(opts.code)) throw pairingError('PAIRING_INVALID');
  const code = normalisePairingCode(opts.code);
  const deadline = Date.now() + (opts.timeoutMs ?? PAIRING_TIMEOUT_MS);
  const left = (): number => Math.max(1, deadline - Date.now());

  let link: ReturnType<typeof openLink>;
  try {
    link = openLink({
      address: opts.address,
      port: opts.port,
      protocol: PAIR_PROTOCOL,
      timeoutMs: left(),
      maxPayload: PAIRING_MAX_FRAME,
    });
  } catch (err) {
    throw notConnected(err);
  }
  const { ws, opened } = link;
  try {
    const peer = await opened.catch((err: unknown) => {
      throw notConnected(err);
    });

    const nonce = randomBytes(32).toString('hex');
    let answer: unknown;
    try {
      answer = await request(ws, 'pair.proof', { nonce }, left());
    } catch (err) {
      throw err instanceof RemoteError
        ? pairingError('PAIRING_PROOF_FAILED')
        : pairingError('PAIRING_UNREACHABLE');
    }
    const proof = methods['pair.proof'].result.safeParse(answer);
    if (!proof.success) throw pairingError('PAIRING_PROOF_FAILED');
    const expected = pairingProof(code, peer.fingerprint, nonce);
    if (!sameDigest(expected, proof.data.proof)) throw pairingError('PAIRING_PROOF_FAILED');

    // The machine proved it shows this code for this certificate: it is the one.
    opts.accept?.(proof.data.machine);

    let claimedAnswer: unknown;
    try {
      claimedAnswer = await request(
        ws,
        'pair.claim',
        { code, deviceName: opts.deviceName },
        left(),
      );
    } catch (err) {
      if (
        err instanceof RemoteError &&
        (err.code === 'PAIRING_EXPIRED' || err.code === 'PAIRING_INVALID')
      )
        throw pairingError(err.code);
      throw pairingError(err instanceof RemoteError ? 'PAIRING_INVALID' : 'PAIRING_UNREACHABLE');
    }
    const claimed = methods['pair.claim'].result.safeParse(claimedAnswer);
    if (
      !claimed.success ||
      !DeviceTokenSchema.safeParse(claimed.data.token).success ||
      claimed.data.machine.id !== proof.data.machine.id
    ) {
      throw pairingError('PAIRING_INVALID');
    }
    return {
      machine: claimed.data.machine,
      deviceId: claimed.data.deviceId,
      certPem: peer.certPem,
      fingerprint: peer.fingerprint,
      token: claimed.data.token,
    };
  } finally {
    closeNow(ws);
  }
};

/**
 * Asks a paired machine to revoke this device, over a short-lived pinned
 * link. True when it did (it may close the link with 4403 before answering);
 * false when it could not be asked. Never throws.
 */
export const unpairFromMachine = async (opts: {
  address: string;
  port: number;
  pin: Pin;
  token: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<boolean> => {
  const deadline = Date.now() + (opts.timeoutMs ?? UNPAIR_TIMEOUT_MS);
  const left = (): number => Math.max(1, deadline - Date.now());
  let link: ReturnType<typeof openLink>;
  try {
    link = openLink({
      address: opts.address,
      port: opts.port,
      protocol: `${DEVICE_PROTOCOL_PREFIX}${opts.token}`,
      pin: opts.pin,
      timeoutMs: left(),
    });
  } catch {
    return false;
  }
  const { ws, opened } = link;
  let closedWith: number | undefined;
  ws.on('close', (c) => {
    closedWith = c;
  });
  try {
    await opened;
    const answer = (await request(ws, 'devices.revoke', { deviceId: opts.deviceId }, left())) as {
      revoked?: unknown;
    };
    return answer?.revoked === true;
  } catch {
    return closedWith === REVOKED;
  } finally {
    closeNow(ws);
  }
};

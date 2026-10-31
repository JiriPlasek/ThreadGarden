import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Device } from '@threadgarden/protocol';

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
/** No 0/O, 1/I/L: 31 characters, easy to read out and type. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
/** Largest multiple of the alphabet size that fits in a byte; larger bytes are rejected (no modulo bias). */
const BYTE_LIMIT = 256 - (256 % PAIRING_ALPHABET.length);

type Options = { now?: () => number; random?: (n: number) => Buffer };
type LiveCode = { normalised: string; expiresAt: number; failures: number };
type DeviceRow = { id: string; name: string; created_at: number; last_seen: number | null };

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
/** Compares through a hash of both sides so the buffers always have the same length. */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));
const normalise = (code: string): string => code.replace(/[-\s]/g, '').toUpperCase();
const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastSeen: r.last_seen,
});

/**
 * The devices paired with this service, and the one-time pairing code that
 * adds a new one. The code lives in memory only (a restart invalidates it);
 * device tokens are stored as sha256 hashes, never in the clear.
 */
export class DeviceRegistry {
  private live: LiveCode | null = null;
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;

  constructor(
    private readonly db: DatabaseSync,
    opts: Options = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? randomBytes;
  }

  /** Replaces any live code with a new one, shown as `XXXX-XXXX-XXXX`. */
  createPairingCode(): { code: string; expiresAt: number } {
    let raw = '';
    while (raw.length < CODE_LENGTH) {
      for (const byte of this.random(CODE_LENGTH * 2)) {
        if (byte < BYTE_LIMIT && raw.length < CODE_LENGTH)
          raw += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
      }
    }
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.live = { normalised: raw, expiresAt, failures: 0 };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, expiresAt };
  }

  /** HMAC of the certificate fingerprint keyed by the live code, or null when the code is not live. */
  proof(code: string, fingerprint256: string): string | null {
    const live = this.liveCode();
    const key = normalise(code);
    if (!live || !sameSecret(live.normalised, key)) return null;
    return createHmac('sha256', key).update(fingerprint256).digest('hex');
  }

  /** Spends the live code on a new device. A wrong code counts against the live one; the fifth kills it. */
  claim(
    code: string,
    deviceName: string,
  ): { deviceId: string; token: string } | { error: 'PAIRING_INVALID' | 'PAIRING_EXPIRED' } {
    const held = this.live;
    if (!held) return { error: 'PAIRING_INVALID' };
    const matches = sameSecret(held.normalised, normalise(code));
    if (this.now() > held.expiresAt)
      return { error: matches ? 'PAIRING_EXPIRED' : 'PAIRING_INVALID' };
    if (!matches) {
      held.failures++;
      if (held.failures >= PAIRING_MAX_FAILURES) this.live = null;
      return { error: 'PAIRING_INVALID' };
    }
    this.live = null;
    const token = randomBytes(32).toString('hex');
    const deviceId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO devices (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(deviceId, deviceName, sha256(token).toString('hex'), this.now());
    return { deviceId, token };
  }

  verify(token: string): Device | null {
    const hash = sha256(token).toString('hex');
    const row = this.db
      .prepare(
        'SELECT id, name, created_at, last_seen, token_hash FROM devices WHERE token_hash = ?',
      )
      .get(hash) as (DeviceRow & { token_hash: string }) | undefined;
    if (!row || !sameSecret(row.token_hash, hash)) return null;
    return toDevice(row);
  }

  touch(deviceId: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(this.now(), deviceId);
  }

  list(): Device[] {
    const rows = this.db
      .prepare('SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at, id')
      .all() as DeviceRow[];
    return rows.map(toDevice);
  }

  revoke(deviceId: string): boolean {
    const removed =
      Number(this.db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes) > 0;
    if (removed) for (const cb of [...this.revokeListeners]) cb(deviceId);
    return removed;
  }

  onRevoke(cb: (deviceId: string) => void): () => void {
    this.revokeListeners.add(cb);
    return () => {
      this.revokeListeners.delete(cb);
    };
  }

  private liveCode(): LiveCode | null {
    return this.live && this.now() <= this.live.expiresAt ? this.live : null;
  }
}

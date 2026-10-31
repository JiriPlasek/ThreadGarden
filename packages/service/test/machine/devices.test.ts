import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { DeviceRegistry } from '../../src/machine/devices.js';

describe('device registry', () => {
  let t = 1_000;
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-devices-')), 'db')).raw;
  const registry = (opts?: ConstructorParameters<typeof DeviceRegistry>[1]) => {
    db.exec('DELETE FROM devices');
    return new DeviceRegistry(db, opts);
  };

  it('issues a token for a live code once', () => {
    const r = registry();
    const { code } = r.createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const ok = r.claim(code.toLowerCase().replaceAll('-', ' '), 'Gaming PC');
    expect(ok).toMatchObject({
      deviceId: expect.any(String),
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(r.claim(code, 'again')).toEqual({ error: 'PAIRING_INVALID' });
    expect(r.verify((ok as { token: string }).token)?.name).toBe('Gaming PC');
  });
  it('expires codes after 5 minutes', () => {
    const r = registry({ now: () => t });
    const { code } = r.createPairingCode();
    t += 5 * 60_000 + 1;
    expect(r.claim(code, 'x')).toEqual({ error: 'PAIRING_EXPIRED' });
    expect(r.proof('fp', 'n')).toBeNull();
  });
  it('kills the code after five wrong claims', () => {
    const r = registry();
    const { code } = r.createPairingCode();
    for (let i = 0; i < 5; i++) r.claim('AAAA-AAAA-AAAA', 'x');
    expect(r.claim(code, 'x')).toEqual({ error: 'PAIRING_INVALID' });
  });
  it('proves the live code over the certificate fingerprint and the nonce', () => {
    const r = registry();
    const { code } = r.createPairingCode();
    expect(r.proof('AA:BB', 'n1')).toBe(
      createHmac('sha256', code.replaceAll('-', '')).update('AA:BB\nn1').digest('hex'),
    );
    expect(r.proof('AA:BB', 'n2')).not.toBe(r.proof('AA:BB', 'n1'));
  });
  it('has no proof before a code exists or once it is consumed or killed', () => {
    const r = registry();
    expect(r.proof('AA:BB', 'n')).toBeNull();
    r.claim(r.createPairingCode().code, 'x');
    expect(r.proof('AA:BB', 'n')).toBeNull();
    r.createPairingCode();
    for (let i = 0; i < 5; i++) r.claim('AAAA-AAAA-AAAA', 'x');
    expect(r.proof('AA:BB', 'n')).toBeNull();
  });
  it('accepts a claim at exactly the expiry time', () => {
    let now = 100;
    const r = registry({ now: () => now });
    const { code, expiresAt } = r.createPairingCode();
    now = expiresAt;
    expect(r.claim(code, 'x')).toMatchObject({ token: expect.any(String) });
  });
  it('still accepts the right code after four wrong claims', () => {
    const r = registry();
    const { code } = r.createPairingCode();
    for (let i = 0; i < 4; i++) r.claim('AAAA-AAAA-AAAA', 'x');
    expect(r.claim(code, 'x')).toMatchObject({ token: expect.any(String) });
  });
  it('reports a non-matching code against an expired one as invalid', () => {
    let now = 100;
    const r = registry({ now: () => now });
    r.createPairingCode();
    now += 5 * 60_000 + 1;
    expect(r.claim('AAAA-AAAA-AAAA', 'x')).toEqual({ error: 'PAIRING_INVALID' });
  });
  it('stores only token hashes and revokes', () => {
    const r = registry();
    const { token, deviceId } = r.claim(r.createPairingCode().code, 'x') as {
      token: string;
      deviceId: string;
    };
    const rows = db.prepare('SELECT * FROM devices').all() as { token_hash: string }[];
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    const seen: string[] = [];
    r.onRevoke((id) => seen.push(id));
    expect(r.revoke(deviceId)).toBe(true);
    expect(r.verify(token)).toBeNull();
    expect(seen).toEqual([deviceId]);
    expect(r.revoke(deviceId)).toBe(false);
  });
  it('calls every revoke listener even when one throws', () => {
    const r = registry();
    const { deviceId } = r.claim(r.createPairingCode().code, 'x') as { deviceId: string };
    const seen: string[] = [];
    r.onRevoke(() => {
      throw new Error('boom');
    });
    r.onRevoke((id) => seen.push(id));
    expect(r.revoke(deviceId)).toBe(true);
    expect(seen).toEqual([deviceId]);
    expect(r.list()).toEqual([]);
  });
  it('tells whether a code is live without giving it away', () => {
    let now = 100;
    const r = registry({ now: () => now });
    expect(r.hasLiveCode()).toBe(false);
    r.claim(r.createPairingCode().code, 'x');
    expect(r.hasLiveCode()).toBe(false); // spent
    const { expiresAt } = r.createPairingCode();
    expect(r.hasLiveCode()).toBe(true);
    now = expiresAt;
    expect(r.hasLiveCode()).toBe(true);
    now = expiresAt + 1;
    expect(r.hasLiveCode()).toBe(false); // expired
    now = 100;
    r.createPairingCode();
    for (let i = 0; i < 5; i++) r.claim('AAAA-AAAA-AAAA', 'x');
    expect(r.hasLiveCode()).toBe(false); // killed
  });
  it('replaces the live code when a new one is created', () => {
    const r = registry();
    const a = r.createPairingCode().code;
    const b = r.createPairingCode().code;
    expect(r.claim(a, 'x')).toEqual({ error: 'PAIRING_INVALID' });
    expect(r.claim(b, 'x')).toMatchObject({ token: expect.any(String) });
  });
  it('touches and lists devices without tokens', () => {
    let now = 5;
    const r = registry({ now: () => now });
    const ok = r.claim(r.createPairingCode().code, 'PC') as { deviceId: string };
    now = 9;
    r.touch(ok.deviceId);
    expect(r.list()).toEqual([{ id: ok.deviceId, name: 'PC', createdAt: 5, lastSeen: 9 }]);
    expect(r.verify('nope')).toBeNull();
  });
  it('draws code characters without modulo bias', () => {
    // Bytes >= 248 (the largest multiple of 31 up to 256) are skipped.
    const feed = [255, 250, ...new Array<number>(12).fill(0)];
    let i = 0;
    const random = (n: number) =>
      Buffer.from(Array.from({ length: n }, () => feed[i++ % feed.length] as number));
    expect(registry({ random }).createPairingCode().code).toBe('AAAA-AAAA-AAAA');
  });
});

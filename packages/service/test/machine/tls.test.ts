import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateTlsIdentity } from '../../src/machine/tls';

describe('loadOrCreateTlsIdentity', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-tls-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the identity once, private files, and reuses it', async () => {
    const a = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
    const b = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
    expect(b).toEqual(a);
    expect(new X509Certificate(a.certPem).fingerprint256).toBe(a.fingerprint256);
    expect(a.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'tls', 'key.pem'))).mode & 0o777).toBe(0o600);
    }
  });

  it('issues a certificate valid for about 20 years', async () => {
    const { certPem } = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
    const years =
      (new Date(new X509Certificate(certPem).validTo).getTime() - Date.now()) /
      (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(19.9);
    expect(years).toBeLessThan(20.1);
  });
});

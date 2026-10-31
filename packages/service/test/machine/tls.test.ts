import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateTlsIdentity } from '../../src/machine/tls';

describe('loadOrCreateTlsIdentity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-tls-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const regenReasons = async (): Promise<{
    reasons: string[];
    run: () => ReturnType<typeof loadOrCreateTlsIdentity>;
  }> => {
    const reasons: string[] = [];
    return {
      reasons,
      run: () =>
        loadOrCreateTlsIdentity(dir, 'ubuntu-pc', { onRegenerate: (r) => reasons.push(r) }),
    };
  };

  it('creates the identity once, private files, and reuses it', async () => {
    const { reasons, run } = await regenReasons();
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
    expect(reasons).toEqual([]);
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

  it('regenerates when exactly one file is missing', async () => {
    const { reasons, run } = await regenReasons();
    const a = await run();
    await rm(join(dir, 'tls', 'key.pem'));
    const b = await run();
    expect(reasons).toEqual(['missing']);
    expect(b.fingerprint256).not.toBe(a.fingerprint256);
    expect(await run()).toEqual(b);
  });

  it('regenerates when a file is empty', async () => {
    const { reasons, run } = await regenReasons();
    await run();
    await writeFile(join(dir, 'tls', 'cert.pem'), '');
    await run();
    expect(reasons).toEqual(['missing']);
  });

  it('regenerates corrupt PEM', async () => {
    const { reasons, run } = await regenReasons();
    await run();
    await writeFile(join(dir, 'tls', 'cert.pem'), 'not a certificate');
    const b = await run();
    expect(reasons).toEqual(['unreadable']);
    expect(await run()).toEqual(b);
  });

  it('regenerates when key and cert belong to different pairs', async () => {
    const { reasons, run } = await regenReasons();
    const a = await run();
    const other = await mkdtemp(join(tmpdir(), 'tg-tls-other-'));
    try {
      const o = await loadOrCreateTlsIdentity(other, 'other');
      await writeFile(join(dir, 'tls', 'key.pem'), o.keyPem);
      const b = await run();
      expect(reasons).toEqual(['mismatch']);
      expect(b.fingerprint256).not.toBe(a.fingerprint256);
      expect(b.fingerprint256).not.toBe(o.fingerprint256);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('cleans its temp file when a write fails', async () => {
    // A directory where key.pem should be makes the final rename fail.
    await mkdir(join(dir, 'tls', 'key.pem'), { recursive: true });
    await expect(loadOrCreateTlsIdentity(dir, 'ubuntu-pc')).rejects.toThrow();
    expect((await readdir(join(dir, 'tls'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

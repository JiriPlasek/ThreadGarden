import { X509Certificate, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export type TlsIdentity = { keyPem: string; certPem: string; fingerprint256: string };

const VALIDITY_YEARS = 20;

const writePrivate = async (target: string, data: string): Promise<void> => {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

const readPair = async (keyFile: string, certFile: string) => {
  try {
    const [keyPem, certPem] = await Promise.all([
      readFile(keyFile, 'utf8'),
      readFile(certFile, 'utf8'),
    ]);
    return keyPem && certPem ? { keyPem, certPem } : null;
  } catch {
    return null;
  }
};

const toIdentity = (keyPem: string, certPem: string): TlsIdentity => ({
  keyPem,
  certPem,
  fingerprint256: new X509Certificate(certPem).fingerprint256,
});

/**
 * The machine's self-signed TLS identity: created once under `<dataDir>/tls`, then reused.
 * Devices pin its SHA-256 fingerprint at pairing time.
 */
export const loadOrCreateTlsIdentity = async (
  dataDir: string,
  commonName: string,
): Promise<TlsIdentity> => {
  const dir = join(dataDir, 'tls');
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');

  const existing = await readPair(keyFile, certFile);
  if (existing) return toIdentity(existing.keyPem, existing.certPem);

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + VALIDITY_YEARS);
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate,
  });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivate(keyFile, pems.private);
  await writePrivate(certFile, pems.cert);
  return toIdentity(pems.private, pems.cert);
};

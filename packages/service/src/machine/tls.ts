import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export type TlsIdentity = { keyPem: string; certPem: string; fingerprint256: string };

const VALIDITY_YEARS = 20;
/** How far a new certificate's validity starts in the past (clock skew between machines). */
const BACKDATE_MS = 24 * 60 * 60_000;

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

type Loaded =
  | { kind: 'ok'; identity: TlsIdentity }
  | { kind: 'none' }
  | { kind: 'bad'; reason: 'missing' | 'unreadable' | 'mismatch' };

const readIfPresent = async (file: string): Promise<string | null> => {
  try {
    return (await readFile(file, 'utf8')) || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

const loadExisting = async (keyFile: string, certFile: string): Promise<Loaded> => {
  let keyPem: string | null;
  let certPem: string | null;
  try {
    [keyPem, certPem] = await Promise.all([readIfPresent(keyFile), readIfPresent(certFile)]);
  } catch {
    return { kind: 'bad', reason: 'unreadable' };
  }
  if (keyPem === null && certPem === null) return { kind: 'none' };
  if (keyPem === null || certPem === null) return { kind: 'bad', reason: 'missing' };
  try {
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) return { kind: 'bad', reason: 'mismatch' };
    return { kind: 'ok', identity: { keyPem, certPem, fingerprint256: cert.fingerprint256 } };
  } catch {
    return { kind: 'bad', reason: 'unreadable' };
  }
};

/**
 * The machine's self-signed TLS identity: created once under `<dataDir>/tls`, then reused.
 * Devices pin its SHA-256 fingerprint at pairing time.
 */
export const loadOrCreateTlsIdentity = async (
  dataDir: string,
  commonName: string,
  opts?: { onRegenerate?: (reason: string) => void },
): Promise<TlsIdentity> => {
  const dir = join(dataDir, 'tls');
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');

  const existing = await loadExisting(keyFile, certFile);
  if (existing.kind === 'ok') return existing.identity;
  // An unusable identity is replaced, never fatal; devices must re-pair against the new pin.
  if (existing.kind === 'bad') opts?.onRegenerate?.(existing.reason);

  const now = Date.now();
  const notAfterDate = new Date(now);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + VALIDITY_YEARS);
  // Valid from a day ago: a device whose clock is behind this machine's must
  // not find a brand-new certificate "not yet valid" (devices check the dates).
  const notBeforeDate = new Date(now - BACKDATE_MS);
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
  });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Cert first, key last: a crash in between leaves a pair that fails validation and is regenerated.
  await writePrivate(certFile, pems.cert);
  await writePrivate(keyFile, pems.private);
  return {
    keyPem: pems.private,
    certPem: pems.cert,
    fingerprint256: new X509Certificate(pems.cert).fingerprint256,
  };
};

/**
 * Verifies a release's update signatures against the public key the app
 * ships (`plugins.updater.pubkey` in tauri.conf.json) before the release is
 * published: a release signed with any other key could never be installed by
 * the copies already out there. Tauri signs with minisign: Ed25519 over the
 * file's BLAKE2b-512 hash ("ED"), plus a signed trusted comment.
 *
 * `node scripts/verify-signatures.mjs <dir> <tauri.conf.json>` checks every
 * `<file>.sig` in `<dir>` against `<file>`.
 */
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo, before the 32 raw key bytes. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** The base64 line of a minisign text block (the line after `untrusted comment:`). */
const lines = (base64Text) =>
  Buffer.from(base64Text.trim(), 'base64').toString('utf8').split(/\r?\n/);

const publicKeyOf = (pubkeyBase64) => {
  const bytes = Buffer.from(lines(pubkeyBase64)[1] ?? '', 'base64');
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString() !== 'Ed') return null;
  return {
    keyId: bytes.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI, bytes.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
};

/**
 * @param {Buffer} file the signed file's bytes
 * @param {string} sigBase64 the `.sig` file's content (base64 of the minisign signature text)
 * @param {string} pubkeyBase64 `plugins.updater.pubkey`
 * @returns {boolean} the file is signed by that key, and its trusted comment too
 */
export const verifySignature = (file, sigBase64, pubkeyBase64) => {
  try {
    const pub = publicKeyOf(pubkeyBase64);
    if (!pub) return false;
    const [, sigLine, trustedLine, globalLine] = lines(sigBase64);
    const sig = Buffer.from(sigLine ?? '', 'base64');
    if (sig.length !== 74 || !sig.subarray(2, 10).equals(pub.keyId)) return false;
    const algorithm = sig.subarray(0, 2).toString();
    const signature = sig.subarray(10);
    const message =
      algorithm === 'ED'
        ? createHash('blake2b512').update(file).digest()
        : algorithm === 'Ed'
          ? file
          : null;
    if (!message || !verify(null, message, pub.key, signature)) return false;
    const prefix = 'trusted comment: ';
    if (!trustedLine?.startsWith(prefix)) return false;
    const trusted = Buffer.from(trustedLine.slice(prefix.length));
    const global = Buffer.from(globalLine ?? '', 'base64');
    return verify(null, Buffer.concat([signature, trusted]), pub.key, global);
  } catch {
    return false;
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [dir, confPath] = process.argv.slice(2);
  const pubkey = JSON.parse(await readFile(confPath, 'utf8')).plugins?.updater?.pubkey ?? '';
  const sigs = (await readdir(dir)).filter((n) => n.endsWith('.sig'));
  let bad = 0;
  for (const name of sigs) {
    const target = name.slice(0, -'.sig'.length);
    const ok = verifySignature(
      await readFile(join(dir, target)),
      await readFile(join(dir, name), 'utf8'),
      pubkey,
    );
    console.log(`${ok ? 'ok  ' : 'BAD '} ${target}`);
    if (!ok) bad++;
  }
  if (sigs.length === 0) console.error('No signatures found.');
  if (bad > 0 || sigs.length === 0) process.exitCode = 1;
}

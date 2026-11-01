import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest } from '../../../../scripts/check-manifest.mjs';
import { makeManifest } from '../../../../scripts/make-manifest.mjs';
import { sumsFor } from '../../../../scripts/release-sums.mjs';
import { verifySignature } from '../../../../scripts/verify-signatures.mjs';

const BASE = 'https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.3.0';
const ASSETS = [
  'Threadgarden_0.3.0_x64-setup.exe',
  'Threadgarden_0.3.0_x64-setup.exe.sig',
  'Threadgarden_aarch64.app.tar.gz',
  'Threadgarden_aarch64.app.tar.gz.sig',
  'Threadgarden_0.3.0_amd64.AppImage',
  'Threadgarden_0.3.0_amd64.AppImage.sig',
];

const manifest = () => ({
  version: '0.3.0',
  notes: '',
  pub_date: '2026-11-01T00:00:00Z',
  platforms: {
    'windows-x86_64': { signature: 'sig-w', url: `${BASE}/Threadgarden_0.3.0_x64-setup.exe` },
    'darwin-aarch64': { signature: 'sig-m', url: `${BASE}/Threadgarden_aarch64.app.tar.gz` },
    'linux-x86_64': { signature: 'sig-l', url: `${BASE}/Threadgarden_0.3.0_amd64.AppImage` },
  },
});

describe('checkManifest', () => {
  it('accepts a manifest covering every platform with files in the release', () => {
    expect(checkManifest(manifest(), '0.3.0', ASSETS)).toEqual([]);
  });

  it('refuses another version', () => {
    expect(checkManifest(manifest(), '0.3.1', ASSETS)).toEqual([
      'latest.json is for 0.3.0, not 0.3.1',
    ]);
  });

  it('refuses a missing platform', () => {
    const m = manifest();
    delete (m.platforms as Record<string, unknown>)['darwin-aarch64'];
    expect(checkManifest(m, '0.3.0', ASSETS)).toEqual(['darwin-aarch64 is missing']);
  });

  it('refuses a url naming a file the release does not have', () => {
    const m = manifest();
    m.platforms['linux-x86_64'].url = `${BASE}/Threadgarden_0.3.0_amd64.deb`;
    expect(checkManifest(m, '0.3.0', ASSETS)).toEqual([
      'linux-x86_64 points at Threadgarden_0.3.0_amd64.deb, which the release does not have',
    ]);
  });

  it('refuses a platform without a signature', () => {
    const m = manifest();
    m.platforms['windows-x86_64'].signature = '';
    expect(checkManifest(m, '0.3.0', ASSETS)).toEqual(['windows-x86_64 has no signature']);
  });

  it('refuses something that is not a manifest', () => {
    expect(checkManifest(null, '0.3.0', ASSETS)).toEqual(['latest.json is not an update manifest']);
  });
});

describe('sumsFor', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('lists every file but SHA256SUMS, sorted, in sha256sum format', async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-sums-'));
    await writeFile(join(dir, 'b.txt'), 'bee');
    await writeFile(join(dir, 'a.txt'), 'ay');
    await writeFile(join(dir, 'SHA256SUMS'), 'old');
    const hex = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(await sumsFor(dir)).toBe(`${hex('ay')}  a.txt\n${hex('bee')}  b.txt\n`);
  });
});

describe('makeManifest', () => {
  const files = [
    'Threadgarden_0.3.0_x64-setup.exe',
    'Threadgarden_0.3.0_x64-setup.exe.sig',
    'Threadgarden_0.3.0_x64_en-US.msi',
    'Threadgarden_0.3.0_x64_en-US.msi.sig',
    'Threadgarden_aarch64.app.tar.gz',
    'Threadgarden_aarch64.app.tar.gz.sig',
    'Threadgarden_0.3.0_aarch64.dmg',
    'Threadgarden_0.3.0_amd64.AppImage',
    'Threadgarden_0.3.0_amd64.AppImage.sig',
    'Threadgarden_0.3.0_amd64.deb',
  ];
  const sigs = {
    'Threadgarden_0.3.0_x64-setup.exe.sig': 'sig-nsis',
    'Threadgarden_0.3.0_x64_en-US.msi.sig': 'sig-msi',
    'Threadgarden_aarch64.app.tar.gz.sig': 'sig-mac',
    'Threadgarden_0.3.0_amd64.AppImage.sig': 'sig-appimage',
  };

  it('points each platform at its updater file and signature (NSIS on Windows)', () => {
    const m = makeManifest({
      version: '0.3.0',
      pubDate: '2026-11-01T00:00:00Z',
      base: BASE,
      files,
      sigs,
    });
    expect(m).toEqual({
      version: '0.3.0',
      notes: `See ${'https://github.com/JiriPlasek/ThreadGarden/releases/tag/v0.3.0'}`,
      pub_date: '2026-11-01T00:00:00Z',
      platforms: {
        'windows-x86_64': {
          signature: 'sig-nsis',
          url: `${BASE}/Threadgarden_0.3.0_x64-setup.exe`,
        },
        'darwin-aarch64': { signature: 'sig-mac', url: `${BASE}/Threadgarden_aarch64.app.tar.gz` },
        'linux-x86_64': {
          signature: 'sig-appimage',
          url: `${BASE}/Threadgarden_0.3.0_amd64.AppImage`,
        },
      },
    });
    expect(checkManifest(m, '0.3.0', files)).toEqual([]);
  });

  it('leaves out a platform whose signed file is missing (the check then refuses it)', () => {
    const m = makeManifest({
      version: '0.3.0',
      pubDate: '2026-11-01T00:00:00Z',
      base: BASE,
      files: files.filter((f) => !f.includes('AppImage')),
      sigs,
    });
    expect(Object.keys(m.platforms)).toEqual(['windows-x86_64', 'darwin-aarch64']);
    expect(checkManifest(m, '0.3.0', files)).toEqual(['linux-x86_64 is missing']);
  });
});

describe('verifySignature', () => {
  /** A minisign key pair as Tauri's signer writes it, and a signer for files. */
  const keyPair = (keyId: Buffer) => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const keyText = `untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
    const sign = (file: Buffer): string => {
      const sig = edSign(null, createHash('blake2b512').update(file).digest(), privateKey);
      const trusted = 'timestamp:1793500000\tfile:app.exe';
      const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
      return Buffer.from(text).toString('base64');
    };
    return { pubkey: Buffer.from(keyText).toString('base64'), sign };
  };
  const file = Buffer.from('the installer bytes');

  it('accepts a file signed with the key the app ships', () => {
    const k = keyPair(Buffer.from('0688fa7b56519891', 'hex'));
    expect(verifySignature(file, k.sign(file), k.pubkey)).toBe(true);
  });

  it('refuses a file that changed after signing', () => {
    const k = keyPair(Buffer.from('0688fa7b56519891', 'hex'));
    expect(verifySignature(Buffer.from('other bytes'), k.sign(file), k.pubkey)).toBe(false);
  });

  it('refuses a signature made with another key', () => {
    const shipped = keyPair(Buffer.from('0688fa7b56519891', 'hex'));
    const other = keyPair(Buffer.from('1111111111111111', 'hex'));
    expect(verifySignature(file, other.sign(file), shipped.pubkey)).toBe(false);
  });

  it('refuses something that is not a signature', () => {
    const k = keyPair(Buffer.from('0688fa7b56519891', 'hex'));
    expect(verifySignature(file, Buffer.from('nonsense').toString('base64'), k.pubkey)).toBe(false);
  });
});

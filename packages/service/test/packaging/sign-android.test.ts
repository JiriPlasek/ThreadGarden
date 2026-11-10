import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The release workflow's signing step (`scripts/sign-android.sh`). */
const script = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../scripts/sign-android.sh',
);

const NAMES = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
] as const;

/** Made-up secrets, recognisable if one were ever printed. */
const SECRETS = {
  ANDROID_KEYSTORE_BASE64: Buffer.from('not-a-keystore-QX81').toString('base64'),
  ANDROID_KEYSTORE_PASSWORD: 'store-pw-QX82',
  ANDROID_KEY_ALIAS: 'alias-QX83',
  ANDROID_KEY_PASSWORD: 'key-pw-QX84',
};
/** A PKCS12 keystore (keytool's default) has one password: the key's is the store's. */
const SAME_PASSWORD = { ...SECRETS, ANDROID_KEY_PASSWORD: SECRETS.ANDROID_KEYSTORE_PASSWORD };

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const buildTools = (): string | null => {
  if (!sdk || !existsSync(join(sdk, 'build-tools'))) return null;
  const versions = readdirSync(join(sdk, 'build-tools')).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const newest = versions.at(-1);
  return newest && existsSync(join(sdk, 'build-tools', newest, 'apksigner'))
    ? join(sdk, 'build-tools', newest)
    : null;
};
const keytool = spawnSync('keytool', ['-help']).error ? null : 'keytool';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-sign-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (env: Record<string, string>, args = [join(dir, 'in.apk'), join(dir, 'out.apk')]) => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !(NAMES as readonly string[]).includes(k)),
  );
  const r = spawnSync('bash', [script, ...args], {
    env: { ...clean, RUNNER_TEMP: dir, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};

const leaks = (output: string): string[] =>
  Object.values(SECRETS)
    .concat(['QX81', 'QX82', 'QX83', 'QX84'])
    .filter((v) => output.includes(v));

describe.skipIf(process.platform === 'win32')('signing the Android APK', () => {
  it('a missing secret stops it, naming each one and printing none', () => {
    const r = run({ ANDROID_KEY_ALIAS: SECRETS.ANDROID_KEY_ALIAS });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::The Android signing secrets are missing');
    for (const name of NAMES.filter((n) => n !== 'ANDROID_KEY_ALIAS')) {
      expect(r.output).toContain(name);
    }
    expect(r.output).not.toMatch(/ANDROID_KEY_ALIAS(?!_)/);
    expect(r.output).toContain('docs/releasing.md');
    expect(leaks(r.output)).toEqual([]);
  });

  it('--check says whether the secrets are there, and nothing else', () => {
    const missing = run({}, ['--check']);
    expect(missing.status).toBe(1);
    for (const name of NAMES) expect(missing.output).toContain(name);
    const there = run(SECRETS, ['--check']);
    expect(there.status).toBe(0);
    expect(there.output).toContain('The Android signing secrets are there.');
    expect(leaks(there.output)).toEqual([]);
  });

  it('no APK to sign stops it before the key is written anywhere', async () => {
    const r = run(SECRETS);
    expect(r.status).toBe(1);
    expect(r.output).toContain('No APK to sign');
    expect(leaks(r.output)).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it.skipIf(!buildTools() || !keytool || !sdk || !existsSync(join(sdk, 'platforms')))(
    'signs with the key, leaves no keystore behind, and prints no secret',
    async () => {
      // A throwaway key, and a minimal APK (a zip with a manifest) to sign.
      const jks = join(dir, 'key.jks');
      const made = spawnSync('keytool', [
        '-genkeypair',
        '-keystore',
        jks,
        '-storepass',
        SECRETS.ANDROID_KEYSTORE_PASSWORD,
        '-keypass',
        SECRETS.ANDROID_KEYSTORE_PASSWORD,
        '-alias',
        SECRETS.ANDROID_KEY_ALIAS,
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '1',
        '-dname',
        'CN=Test',
      ]);
      expect(made.status).toBe(0);
      // A minimal real APK (a manifest only), linked with the SDK's aapt2 and newest platform.
      const apk = join(dir, 'in.apk');
      const manifest = join(dir, 'AndroidManifest.xml');
      await writeFile(
        manifest,
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.example.signing"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><application/></manifest>',
      );
      const platforms = readdirSync(join(sdk!, 'platforms')).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      const linked = spawnSync(join(buildTools()!, 'aapt2'), [
        'link',
        '--manifest',
        manifest,
        '-I',
        join(sdk!, 'platforms', platforms.at(-1)!, 'android.jar'),
        '-o',
        apk,
      ]);
      expect(linked.status).toBe(0);
      await rm(manifest);
      const { readFile } = await import('node:fs/promises');
      const keystore = (await readFile(jks)).toString('base64');
      await rm(jks);
      // A wrong password: a plain error, no secret, no half-signed APK, no keystore left.
      const wrong = run({ ...SECRETS, ANDROID_KEYSTORE_BASE64: keystore });
      expect(wrong.status).toBe(1);
      expect(wrong.output).toContain('::error::The APK could not be signed with the key');
      expect(leaks(wrong.output)).toEqual([]);
      expect(await readdir(dir)).toEqual(['in.apk']);

      const r = run({ ...SAME_PASSWORD, ANDROID_KEYSTORE_BASE64: keystore });
      expect(r.output).toContain('Signed out.apk');
      expect(r.status).toBe(0);
      expect(leaks(r.output)).toEqual([]);
      // Only the two APKs remain: no keystore, no work folder.
      expect((await readdir(dir)).sort()).toEqual(['in.apk', 'out.apk']);
    },
    60_000,
  );
});

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
/** What the script reads besides the four, cleared so the machine's own env can't leak in. */
const OTHERS = ['ANDROID_CERT_SHA256', 'VERSION'];

/** Made-up secrets, recognisable if one were ever printed. */
const SECRETS = {
  ANDROID_KEYSTORE_BASE64: Buffer.from('not-a-keystore-QX81').toString('base64'),
  ANDROID_KEYSTORE_PASSWORD: 'store-pw-QX82',
  ANDROID_KEY_ALIAS: 'alias-QX83',
  ANDROID_KEY_PASSWORD: 'key-pw-QX84',
};
/** A PKCS12 keystore (keytool's default) has one password: the key's is the store's. */
const SAME_PASSWORD = { ...SECRETS, ANDROID_KEY_PASSWORD: SECRETS.ANDROID_KEYSTORE_PASSWORD };

const newest = (parent: string): string | null => {
  if (!existsSync(parent)) return null;
  const all = readdirSync(parent).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return all.length ? join(parent, all.at(-1)!) : null;
};
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const buildTools = (): string | null => {
  const tools = sdk ? newest(join(sdk, 'build-tools')) : null;
  return tools && existsSync(join(tools, 'apksigner')) ? tools : null;
};
/** The NDK's clang for 64-bit ARM, to link a tiny native library with a chosen page size. */
const ndk =
  process.env.NDK_HOME ?? process.env.ANDROID_NDK_HOME ?? (sdk && newest(join(sdk, 'ndk')));
const clang = ((): string | null => {
  const host = ndk ? newest(join(ndk, 'toolchains/llvm/prebuilt')) : null;
  const c = host ? join(host, 'bin/aarch64-linux-android26-clang') : null;
  return c && existsSync(c) ? c : null;
})();
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
    Object.entries(process.env).filter(
      ([k]) => !(NAMES as readonly string[]).includes(k) && !OTHERS.includes(k),
    ),
  );
  const r = spawnSync('bash', [script, ...args], {
    env: { ...clean, ...(ndk ? { NDK_HOME: ndk } : {}), RUNNER_TEMP: dir, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};

const leaks = (output: string): string[] =>
  Object.values(SECRETS)
    .concat(['QX81', 'QX82', 'QX83', 'QX84'])
    .filter((v) => output.includes(v));

/** A shared library linked for 64-bit ARM with `pageSize`-aligned LOAD segments. */
const library = (pageSize: number): string => {
  const src = join(dir, 'x.c');
  const so = join(dir, `libx-${pageSize}.so`);
  spawnSync('sh', ['-c', `printf 'int x(void) { return 1; }\\n' > '${src}'`]);
  const r = spawnSync(clang!, [
    '-shared',
    '-o',
    so,
    src,
    `-Wl,-z,max-page-size=${pageSize}`,
    `-Wl,-z,common-page-size=${pageSize}`,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return so;
};

/**
 * A minimal real APK: a manifest linked with the SDK's aapt2, plus `so` as
 * `lib/arm64-v8a/libx.so` (stored, as Android wants native libraries).
 */
const apk = async (so: string | null, versionName = '1.2.3'): Promise<string> => {
  const out = join(dir, 'in.apk');
  const manifest = join(dir, 'AndroidManifest.xml');
  await writeFile(
    manifest,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.example.signing" android:versionCode="1" android:versionName="${versionName}"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><application/></manifest>`,
  );
  const platform = newest(join(sdk!, 'platforms'))!;
  const linked = spawnSync(join(buildTools()!, 'aapt2'), [
    'link',
    '--manifest',
    manifest,
    '-I',
    join(platform, 'android.jar'),
    '-o',
    out,
  ]);
  if (linked.status !== 0) throw new Error(String(linked.stderr));
  if (so) {
    const added = spawnSync('python3', [
      '-c',
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.write(sys.argv[2],"lib/arm64-v8a/libx.so",compress_type=zipfile.ZIP_STORED); z.close()',
      out,
      so,
    ]);
    if (added.status !== 0) throw new Error(String(added.stderr));
  }
  for (const name of await readdir(dir)) {
    if (name !== 'in.apk' && name !== 'key.jks') await rm(join(dir, name));
  }
  return out;
};

/** A throwaway PKCS12 key, as base64, and its certificate's SHA-256. */
const key = async (): Promise<{ base64: string; sha256: string }> => {
  const jks = join(dir, 'key.jks');
  const made = spawnSync('keytool', [
    ...['-genkeypair', '-keystore', jks, '-storepass', SECRETS.ANDROID_KEYSTORE_PASSWORD],
    ...['-keypass', SECRETS.ANDROID_KEYSTORE_PASSWORD, '-alias', SECRETS.ANDROID_KEY_ALIAS],
    ...['-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=Test'],
  ]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const listed = spawnSync(
    'keytool',
    ['-list', '-v', '-keystore', jks, '-storepass', SECRETS.ANDROID_KEYSTORE_PASSWORD],
    { encoding: 'utf8' },
  );
  const sha256 = /SHA256:\s*([0-9A-F:]+)/.exec(listed.stdout)![1]!;
  const base64 = (await readFile(jks)).toString('base64');
  await rm(jks);
  return { base64, sha256 };
};

const canSign =
  !!buildTools() && !!keytool && !!clang && !!sdk && existsSync(join(sdk, 'platforms'));

describe.skipIf(process.platform === 'win32')('signing the Android APK', () => {
  it('a missing value stops it, naming each one and printing none', () => {
    const r = run({ ANDROID_KEY_ALIAS: SECRETS.ANDROID_KEY_ALIAS });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::The Android signing values are missing');
    const named = /missing: ([A-Z0-9_ ]+)\./.exec(r.output)![1]!.split(' ');
    expect(named).toEqual(NAMES.filter((n) => n !== 'ANDROID_KEY_ALIAS'));
    expect(r.output).toContain('docs/releasing.md');
    expect(leaks(r.output)).toEqual([]);
  });

  it('--check says whether the values are there, and nothing else', () => {
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

  it('no build-tools says so', async () => {
    await writeFile(join(dir, 'in.apk'), 'not an apk');
    const r = run({ ...SECRETS, ANDROID_HOME: join(dir, 'nowhere'), ANDROID_SDK_ROOT: '' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error::No Android build-tools');
  });

  it.skipIf(!canSign)(
    'a native library aligned to 4 KB stops it; 16 KB passes',
    async () => {
      await apk(library(4096));
      const four = run({}, ['--check-alignment', join(dir, 'in.apk')]);
      expect(four.status).toBe(1);
      expect(four.output).toMatch(/lib\/arm64-v8a\/libx\.so has a LOAD segment aligned to 0x1000/);
      await apk(library(16384));
      const sixteen = run({}, ['--check-alignment', join(dir, 'in.apk')]);
      expect(sixteen.output).toContain('Every native library is aligned to 16 KB.');
      expect(sixteen.status).toBe(0);
      // And the signing itself refuses a 4 KB library before using the key.
      await apk(library(4096));
      const signing = run({ ...SAME_PASSWORD, ANDROID_KEYSTORE_BASE64: (await key()).base64 });
      expect(signing.status).toBe(1);
      expect(signing.output).toContain('below 16 KB');
      expect(await readdir(dir)).toEqual(['in.apk']);
    },
    60_000,
  );

  it.skipIf(!canSign)(
    'a signing failure says which value is wrong, never what it is',
    async () => {
      await apk(library(16384));
      const { base64 } = await key();
      const cases: [Record<string, string>, RegExp][] = [
        [
          { ...SAME_PASSWORD, ANDROID_KEYSTORE_PASSWORD: 'wrong-QX85' },
          /ANDROID_KEYSTORE_PASSWORD is not the keystore's password/,
        ],
        [{ ...SECRETS }, /ANDROID_KEY_PASSWORD is not the key's password/],
        [
          { ...SAME_PASSWORD, ANDROID_KEY_ALIAS: 'nosuch-QX86' },
          /no key under the alias in ANDROID_KEY_ALIAS/,
        ],
      ];
      for (const [env, hint] of cases) {
        const r = run({ ...env, ANDROID_KEYSTORE_BASE64: base64 });
        expect(r.status).toBe(1);
        expect(r.output).toMatch(hint);
        expect(leaks(r.output)).toEqual([]);
        expect(r.output).not.toMatch(/QX85|QX86|Exception|signer #1/);
        expect(await readdir(dir)).toEqual(['in.apk']);
      }
    },
    60_000,
  );

  it.skipIf(!canSign)(
    'signs, checks the signer and the version, and leaves no keystore behind',
    async () => {
      await apk(library(16384), '1.2.3');
      const { base64, sha256 } = await key();
      const ok = { ...SAME_PASSWORD, ANDROID_KEYSTORE_BASE64: base64 };

      // Without the certificate's fingerprint: signed, with a warning.
      const unchecked = run(ok);
      expect(unchecked.status).toBe(0);
      expect(unchecked.output).toContain('::warning::ANDROID_CERT_SHA256 is not set');

      // Another certificate: refused, and no APK left.
      await rm(join(dir, 'out.apk'));
      const other = run({ ...ok, ANDROID_CERT_SHA256: 'AB'.repeat(32) });
      expect(other.status).toBe(1);
      expect(other.output).toContain('::error::The APK is signed by certificate');
      expect(existsSync(join(dir, 'out.apk'))).toBe(false);

      // Another version: refused.
      const version = run({ ...ok, ANDROID_CERT_SHA256: sha256, VERSION: '9.9.9' });
      expect(version.status).toBe(1);
      expect(version.output).toContain("The APK says version '1.2.3', not 9.9.9");

      // All as expected.
      const r = run({ ...ok, ANDROID_CERT_SHA256: sha256, VERSION: '1.2.3' });
      expect(r.output).toContain('Signed out.apk');
      expect(r.status).toBe(0);
      expect(r.output).not.toContain('::warning::');
      expect(leaks(r.output)).toEqual([]);
      // Only the two APKs remain: no keystore, no work folder.
      expect((await readdir(dir)).sort()).toEqual(['in.apk', 'out.apk']);
    },
    90_000,
  );
});

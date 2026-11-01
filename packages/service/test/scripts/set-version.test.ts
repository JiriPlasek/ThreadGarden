import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION_FILES, setVersion } from '../../../../scripts/set-version.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A temp copy of every file that carries the version. */
const copyRepo = async (): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-version-'));
  for (const f of VERSION_FILES) await cp(join(ROOT, f), join(dir, f), { recursive: true });
  return dir;
};

describe('setVersion', () => {
  it('writes the version into every file that carries it and changes nothing else', async () => {
    const root = await copyRepo();
    const before = new Map<string, string>();
    for (const f of VERSION_FILES) before.set(f, await readFile(join(root, f), 'utf8'));
    const current = JSON.parse(before.get('package.json')!).version as string;

    const changed = await setVersion(root, '9.8.7');

    expect([...changed].sort()).toEqual([...VERSION_FILES].sort());
    for (const f of VERSION_FILES) {
      const after = await readFile(join(root, f), 'utf8');
      expect(after).toContain('9.8.7');
      // Only the version string moved: putting the old one back restores the file exactly.
      const restored = f.endsWith('Cargo.lock')
        ? after.replace(/(name = "threadgarden"\r?\nversion = ")9\.8\.7"/, `$1${current}"`)
        : after.replace('9.8.7', current);
      expect(restored).toBe(before.get(f));
    }
  });

  it('lists exactly the seven files the versions test checks', () => {
    expect(VERSION_FILES).toEqual([
      'package.json',
      'apps/desktop/package.json',
      'packages/service/package.json',
      'packages/protocol/package.json',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/Cargo.lock',
    ]);
  });

  it('refuses anything that is not X.Y.Z', async () => {
    const root = await copyRepo();
    await expect(setVersion(root, '1.2')).rejects.toThrow('Version must look like 1.2.3');
    await expect(setVersion(root, 'v1.2.3')).rejects.toThrow('Version must look like 1.2.3');
  });
});

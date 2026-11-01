/**
 * Sets the release version in every file that carries it:
 * `pnpm release:version 0.3.0`. Only the version string changes, so each
 * file keeps its formatting; `apps/desktop/tests/versions.test.ts` checks the
 * files agree.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Every file that carries the version, relative to the repository root. */
export const VERSION_FILES = [
  'package.json',
  'apps/desktop/package.json',
  'packages/service/package.json',
  'packages/protocol/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
];

/** How to find the version in each kind of file: the first match's group 2 is replaced. */
const PATTERNS = {
  json: /^(\s*"version"\s*:\s*")([^"]+)(")/m,
  toml: /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m,
  lock: /^(name = "threadgarden"\r?\nversion = ")([^"]+)(")/m,
};

const patternFor = (file) =>
  file.endsWith('.json') ? PATTERNS.json : file.endsWith('.lock') ? PATTERNS.lock : PATTERNS.toml;

/**
 * Writes `version` into every file of `VERSION_FILES` under `root`.
 * @param {string} root the repository root
 * @param {string} version `X.Y.Z`
 * @returns {Promise<string[]>} the files changed
 */
export const setVersion = async (root, version) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must look like 1.2.3');
  const changed = [];
  for (const file of VERSION_FILES) {
    const path = join(root, file);
    const text = await readFile(path, 'utf8');
    const pattern = patternFor(file);
    if (!pattern.test(text)) throw new Error(`No version found in ${file}`);
    const next = text.replace(pattern, (_m, before, _old, after) => `${before}${version}${after}`);
    if (next !== text) {
      await writeFile(path, next);
      changed.push(file);
    }
  }
  return changed;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const version = process.argv[2] ?? '';
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const changed = await setVersion(root, version);
    console.log(`Version ${version}: ${changed.length ? changed.join(', ') : 'already set'}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

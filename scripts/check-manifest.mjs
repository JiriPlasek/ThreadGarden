/**
 * Checks a release's update manifest (`latest.json`) before the release is
 * published: the right version, every platform the app updates on, each with
 * a signature and a URL naming a file the release really has. Run by the
 * release workflow: `node scripts/check-manifest.mjs latest.json 0.3.0 <asset>…`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The platforms a release must update (Tauri's `<os>-<arch>` keys). */
export const PLATFORMS = ['windows-x86_64', 'darwin-aarch64', 'linux-x86_64'];

/**
 * @param {unknown} manifest the parsed latest.json
 * @param {string} version the version being released
 * @param {string[]} assets the release's file names
 * @returns {string[]} the problems found (none: publish)
 */
export const checkManifest = (manifest, version, assets) => {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.platforms !== 'object') {
    return ['latest.json is not an update manifest'];
  }
  const problems = [];
  if (manifest.version !== version) {
    problems.push(`latest.json is for ${manifest.version}, not ${version}`);
  }
  const have = new Set(assets);
  for (const platform of PLATFORMS) {
    const entry = manifest.platforms?.[platform];
    if (!entry) {
      problems.push(`${platform} is missing`);
      continue;
    }
    if (!entry.signature) problems.push(`${platform} has no signature`);
    const file = decodeURIComponent(
      String(entry.url ?? '')
        .split('/')
        .pop() ?? '',
    );
    if (!have.has(file)) {
      problems.push(`${platform} points at ${file}, which the release does not have`);
    }
  }
  return problems;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [path, version, ...assets] = process.argv.slice(2);
  const problems = checkManifest(JSON.parse(await readFile(path, 'utf8')), version, assets);
  for (const p of problems) console.error(p);
  if (problems.length) process.exitCode = 1;
  else console.log(`latest.json ${version}: ${PLATFORMS.join(', ')}`);
}

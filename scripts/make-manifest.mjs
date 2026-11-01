/**
 * Builds a release's update manifest (`latest.json`, Tauri's format) once
 * every platform's signed files are in the draft release, so parallel build
 * jobs never race to write it. `node scripts/make-manifest.mjs <dir> <version> <base-url>`
 * reads the release's files (and their `.sig` contents) from `<dir>` and
 * writes `<dir>/latest.json`.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Which file updates each platform: the NSIS installer on Windows, the app archive on macOS, the AppImage on Linux. */
const UPDATER_FILES = {
  'windows-x86_64': (f) => /_x64-setup\.exe$/.test(f),
  'darwin-aarch64': (f) => /\.app\.tar\.gz$/.test(f),
  'linux-x86_64': (f) => /\.AppImage$/.test(f),
};

/**
 * @param {{ version: string; pubDate: string; base: string; files: string[]; sigs: Record<string, string> }} input
 *   `base`: the release's download URL (`…/releases/download/vX.Y.Z`); `sigs`: `.sig` file name → its content
 * @returns {{ version: string; notes: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> }}
 */
export const makeManifest = ({ version, pubDate, base, files, sigs }) => {
  const platforms = {};
  for (const [platform, isUpdater] of Object.entries(UPDATER_FILES)) {
    const file = files.find((f) => isUpdater(f) && sigs[`${f}.sig`]);
    if (file)
      platforms[platform] = { signature: sigs[`${file}.sig`].trim(), url: `${base}/${file}` };
  }
  return {
    version,
    notes: `See ${base.replace('/releases/download/', '/releases/tag/')}`,
    pub_date: pubDate,
    platforms,
  };
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [dir, version, base] = process.argv.slice(2);
  const files = (await readdir(dir)).sort();
  const sigs = {};
  for (const f of files.filter((n) => n.endsWith('.sig')))
    sigs[f] = await readFile(join(dir, f), 'utf8');
  const manifest = makeManifest({ version, pubDate: new Date().toISOString(), base, files, sigs });
  await writeFile(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json ${version}: ${Object.keys(manifest.platforms).join(', ')}`);
}

/**
 * Writes `SHA256SUMS` for a release: one `sha256sum`-format line per file in
 * a folder (the release's assets), sorted by name, so `sha256sum -c` checks
 * any download. `node scripts/release-sums.mjs <dir>` writes `<dir>/SHA256SUMS`.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SUMS = 'SHA256SUMS';

/**
 * @param {string} dir the folder holding the release's files
 * @returns {Promise<string>} the SHA256SUMS content
 */
export const sumsFor = async (dir) => {
  const lines = [];
  for (const name of (await readdir(dir)).filter((n) => n !== SUMS).sort()) {
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    const hex = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    lines.push(`${hex}  ${name}\n`);
  }
  return lines.join('');
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = process.argv[2] ?? '.';
  await writeFile(join(dir, SUMS), await sumsFor(dir));
  console.log(`${SUMS} written in ${dir}`);
}

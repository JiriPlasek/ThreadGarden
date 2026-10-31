#!/usr/bin/env node
/**
 * Downloads the Node.js runtime that release builds ship as the `threadgarden-node`
 * Tauri sidecar (spec §9):
 *
 *   node scripts/fetch-node-sidecar.mjs --target <rust-triple>
 *
 * Fetches the pinned Node release's archive for the triple from nodejs.org,
 * checks its SHA-256 against both the hash pinned below and the release's
 * SHASUMS256.txt, extracts only the `node` binary to
 * `apps/desktop/src-tauri/binaries/threadgarden-node-<triple>[.exe]` (what Tauri's
 * `externalBin: ["binaries/threadgarden-node"]` looks for) and writes a
 * `.sha256` stamp beside it. A binary whose stamp matches is left alone, so
 * re-runs (and CI cache hits) download nothing. `--target` defaults to the
 * host triple from `rustc -vV`; `--out <file>` writes the binary elsewhere
 * (the headless package build uses it).
 *
 * Only Node built-ins plus the system `tar` (bsdtar on Windows 10+ and macOS,
 * GNU tar with xz on Linux) are used.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Latest Node 22 LTS ("Jod") at the time of pinning (nodejs.org/dist/index.json). */
const NODE_VERSION = 'v22.23.4';
const DIST = `https://nodejs.org/dist/${NODE_VERSION}`;

/**
 * Rust target triple → nodejs.org archive, the binary inside it, and the
 * archive's SHA-256 from `${DIST}/SHASUMS256.txt` (pinned, so a changed file
 * on the server is caught even if SHASUMS256.txt changed with it).
 */
const TARGETS = {
  'x86_64-pc-windows-msvc': {
    platform: 'win-x64',
    ext: 'zip',
    bin: 'node.exe',
    sha256: 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
  },
  'aarch64-pc-windows-msvc': {
    platform: 'win-arm64',
    ext: 'zip',
    bin: 'node.exe',
    sha256: 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111',
  },
  'x86_64-apple-darwin': {
    platform: 'darwin-x64',
    ext: 'tar.gz',
    bin: 'bin/node',
    sha256: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  },
  'aarch64-apple-darwin': {
    platform: 'darwin-arm64',
    ext: 'tar.gz',
    bin: 'bin/node',
    sha256: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  },
  'x86_64-unknown-linux-gnu': {
    platform: 'linux-x64',
    ext: 'tar.xz',
    bin: 'bin/node',
    sha256: '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce',
  },
  'aarch64-unknown-linux-gnu': {
    platform: 'linux-arm64',
    ext: 'tar.xz',
    bin: 'bin/node',
    sha256: '6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b',
  },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri', 'binaries');

/** Aborts the run; `main`'s cleanup still runs, then the process exits with 1. */
const fail = (message) => {
  throw new Error(message);
};

const argValue = (name) => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
};

const hostTriple = () => {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = r.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (!host) fail('no --target given and `rustc -vV` reported no host triple');
  return host;
};

const sha256File = async (path) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/** The system tar; on Windows the built-in bsdtar (Git's GNU tar cannot read zip). */
const tarCommand = () =>
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

const download = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`GET ${url} → ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
};

const main = async () => {
  const triple = argValue('target') ?? hostTriple();
  const t = TARGETS[triple];
  if (!t) fail(`unsupported target ${triple}; known: ${Object.keys(TARGETS).join(', ')}`);

  const archive = `node-${NODE_VERSION}-${t.platform}.${t.ext}`;
  const exe = triple.includes('windows') ? '.exe' : '';
  const out = argValue('out')
    ? resolve(argValue('out'))
    : join(OUT_DIR, `threadgarden-node-${triple}${exe}`);
  const stamp = `${out}.sha256`;

  // Idempotent: the stamp records the binary's hash and the archive it came from.
  if (existsSync(out) && existsSync(stamp)) {
    const [hash, from] = (await readFile(stamp, 'utf8')).trim().split(/\s+/);
    if (from === archive && hash === (await sha256File(out))) {
      console.log(`fetch-node-sidecar: ${out} is up to date (${archive})`);
      return;
    }
  }

  const work = await mkdtemp(join(tmpdir(), 'threadgarden-node-'));
  try {
    const sums = await (await fetch(`${DIST}/SHASUMS256.txt`)).text();
    const listed = sums.match(
      new RegExp(`^([0-9a-f]{64})  ${archive.replace(/\./g, '\\.')}$`, 'm'),
    );
    if (!listed) fail(`${archive} is not listed in ${DIST}/SHASUMS256.txt`);
    if (listed[1] !== t.sha256) {
      fail(`SHASUMS256.txt lists ${listed[1]} for ${archive}, pinned ${t.sha256}`);
    }

    const file = join(work, archive);
    console.log(`fetch-node-sidecar: downloading ${DIST}/${archive}`);
    await download(`${DIST}/${archive}`, file);
    const got = await sha256File(file);
    if (got !== t.sha256) fail(`checksum mismatch for ${archive}: got ${got}, want ${t.sha256}`);

    // Extract only the node binary, into its own empty directory.
    const member = `node-${NODE_VERSION}-${t.platform}/${t.bin}`;
    const extracted = join(work, 'x');
    await mkdir(extracted);
    const r = spawnSync(tarCommand(), ['-xf', file, '-C', extracted, member], {
      stdio: 'inherit',
    });
    if (r.status !== 0) fail(`tar could not extract ${member} from ${archive}`);

    await mkdir(dirname(out), { recursive: true });
    await copyFile(join(extracted, ...member.split('/')), out);
    if (!exe) await chmod(out, 0o755);
    await writeFile(stamp, `${await sha256File(out)}  ${archive}\n`);
    console.log(`fetch-node-sidecar: wrote ${out}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

await main().catch((err) => {
  console.error(`fetch-node-sidecar: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

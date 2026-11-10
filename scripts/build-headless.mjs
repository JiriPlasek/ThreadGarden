#!/usr/bin/env node
/**
 * Builds a headless Linux or native Windows package:
 *
 *   node scripts/build-headless.mjs [--platform linux|windows] [--arch x64|arm64]
 *
 * Bundles the service, fetches the pinned Node for the arch (through
 * fetch-node-sidecar.mjs, so the download is hash-verified) and writes
 * `dist-headless/threadgarden-headless-<version>-linux-<arch>.tar.gz` plus a
 * `.sha256` file beside it. `--arch` defaults to x64; the Node download is the
 * only network access. Windows x64 writes a zip with install.ps1 and node.exe.
 *
 * Old machines update themselves from what this builds: its names and layout are
 * frozen (`packages/protocol/src/update.ts`; `updater.test.ts` compares them).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-headless');
const TRIPLES = {
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
  windows: { x64: 'x86_64-pc-windows-msvc' },
};

const arg = (name) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** `pnpm` is a .cmd shim on Windows, which only a shell can start; node.exe is not. */
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'pnpm',
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

const main = async () => {
  const arch = arg('arch') ?? 'x64';
  const platform = arg('platform') ?? 'linux';
  const triple = TRIPLES[platform]?.[arch];
  if (!triple) throw new Error(`unsupported platform/arch: ${platform}/${arch}`);
  const windows = platform === 'windows';
  const src = join(ROOT, 'packaging', windows ? 'headless-windows' : 'headless');

  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const name = `threadgarden-headless-${version}`;
  const stage = join(OUT, 'stage');
  const dir = join(stage, name);

  run('pnpm', [
    '--config.verify-deps-before-run=false',
    '--filter',
    '@threadgarden/service',
    'build',
  ]);

  await rm(stage, { recursive: true, force: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'lib'));

  const nodeOut = join(dir, 'bin', windows ? 'node.exe' : 'node');
  run(process.execPath, [
    join(ROOT, 'scripts', 'fetch-node-sidecar.mjs'),
    '--target',
    triple,
    '--out',
    nodeOut,
  ]);
  // The sidecar script's up-to-date stamp does not belong in the release.
  await rm(`${nodeOut}.sha256`, { force: true });

  await copyFile(
    join(ROOT, 'packages', 'service', 'dist', 'service.mjs'),
    join(dir, 'lib', 'service.mjs'),
  );
  const launcher = windows ? 'threadgarden.cmd' : 'threadgarden';
  const installer = windows ? 'install.ps1' : 'install.sh';
  await copyFile(join(src, launcher), join(dir, 'bin', launcher));
  await copyFile(join(src, installer), join(dir, installer));
  if (!windows) {
    await copyFile(join(src, 'threadgarden.service'), join(dir, 'threadgarden.service'));
  }
  await writeFile(join(dir, 'VERSION'), `${version}\n`);
  if (!windows) {
    for (const f of ['bin/node', 'bin/threadgarden', 'install.sh'])
      await chmod(join(dir, f), 0o755);
  }

  const asset = `${name}-${platform}-${arch}.${windows ? 'zip' : 'tar.gz'}`;
  const tarball = join(OUT, asset);
  // On Windows the built-in bsdtar (Git's GNU tar reads `C:` as a remote host).
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  // bsdtar writes zip on Windows/macOS; Linux CI builds its original tarball.
  const r = spawnSync(
    tar,
    windows
      ? ['--format=zip', '-cf', tarball, '-C', stage, name]
      : ['-czf', tarball, '-C', stage, name],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('tar failed');
  await rm(stage, { recursive: true, force: true });

  const sum = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  await writeFile(`${tarball}.sha256`, `${sum}  ${asset}\n`);
  console.log(`build-headless: wrote ${tarball}`);
};

await main().catch((err) => {
  console.error(`build-headless: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

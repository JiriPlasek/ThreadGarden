/**
 * Bundles the service into one ESM file, `dist/service.mjs`, that plain
 * `node --disable-warning=ExperimentalWarning dist/service.mjs` runs: release
 * builds ship it as the `service/service.mjs` resource next to the `threadgarden-node`
 * sidecar. Everything is inlined, the Agent SDK included: the SDK needs no
 * files beside its module at run time, because Threadgarden always passes
 * `pathToClaudeCodeExecutable` (its bundled-CLI lookup is never reached).
 * `require` is provided for the CommonJS dependencies (ws).
 *
 * The one exception is the PTY module (`@lydell/node-pty`, behind `!` commands):
 * it is native, so esbuild keeps it external and this script copies its files
 * into `dist/node_modules/` beside `service.mjs`, where the bundle finds them.
 * `--pty-target <platform>-<arch>` (default: the host) picks which platform
 * package goes along: win32-x64, darwin-arm64 or linux-x64. pnpm installs only
 * the host's, so another target needs that package fetched by name first; the
 * build fails naming it when it is missing. Nothing is ever compiled here.
 * `--out-dir <dir>` writes somewhere other than `dist` (the tests do).
 *
 * `THREADGARDEN_API_KEY_ONLY=1` at build time makes an API-key-only build
 * (spec §5.5): the value is substituted into the bundle, not read when the
 * service runs. The legacy `PAHUB_API_KEY_ONLY=1` still works for one release
 * (spec v1.3 §9), with a deprecation note.
 */
import { chmod, cp, mkdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { protocolAlias } from '../protocol-alias.mjs';

const legacyApiKeyOnly = process.env.PAHUB_API_KEY_ONLY;
if (legacyApiKeyOnly) {
  process.stderr.write(
    'PAHUB_API_KEY_ONLY is deprecated and will be ignored in a later release: set THREADGARDEN_API_KEY_ONLY instead\n',
  );
}
const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argValue = (name) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outDir = resolve(serviceDir, argValue('out-dir') ?? 'dist');

/** The PTY package; esbuild leaves it out and its folders are copied beside the bundle. */
const PTY_PACKAGE = '@lydell/node-pty';
const ptyTarget = argValue('pty-target') ?? `${process.platform}-${process.arch}`;
const ptyPlatformPackage = `${PTY_PACKAGE}-${ptyTarget}`;

/** The folder of an installed package, looked up in the usual places; undefined when absent. */
const findPackage = async (name, from) => {
  const places = [join(serviceDir, 'node_modules'), join(serviceDir, '..', '..', 'node_modules')];
  // pnpm keeps a package's optional dependencies beside the package itself.
  if (from) places.push(dirname(from));
  for (const place of places) {
    const dir = join(place, ...name.split('/'));
    if (existsSync(join(dir, 'package.json'))) return realpath(dir);
  }
  return undefined;
};

/** Copies the PTY package and the target's platform package into `<outDir>/node_modules`. */
const copyPty = async () => {
  const main = await findPackage(PTY_PACKAGE);
  if (!main) throw new Error(`${PTY_PACKAGE} is not installed: run pnpm install`);
  const platform = await findPackage(ptyPlatformPackage, dirname(main));
  if (!platform) {
    throw new Error(
      `${ptyPlatformPackage} is not installed, and the PTY module for ${ptyTarget} needs it. ` +
        `pnpm installs only the host's platform package: fetch this one by name ` +
        `(npm pack ${ptyPlatformPackage}@<the version of ${PTY_PACKAGE}>) and unpack it into node_modules/${ptyPlatformPackage}.`,
    );
  }
  const modules = join(outDir, 'node_modules');
  await rm(modules, { recursive: true, force: true });
  for (const [name, from] of [
    [PTY_PACKAGE, main],
    [ptyPlatformPackage, platform],
  ]) {
    const to = join(modules, ...name.split('/'));
    await mkdir(dirname(to), { recursive: true });
    // Links are followed, so the copy stands alone; debug symbols are not needed at run time.
    await cp(from, to, {
      recursive: true,
      dereference: true,
      filter: (src) => !src.endsWith('.pdb'),
    });
  }
  // The macOS helper that starts each child must stay executable.
  const helper = join(
    modules,
    ...ptyPlatformPackage.split('/'),
    'prebuilds',
    ptyTarget,
    'spawn-helper',
  );
  if (existsSync(helper)) await chmod(helper, 0o755);
};

const apiKeyOnly = process.env.THREADGARDEN_API_KEY_ONLY === '1' || legacyApiKeyOnly === '1';

await build({
  entryPoints: [join(serviceDir, 'src', 'bin.ts')],
  outfile: join(outDir, 'service.mjs'),
  bundle: true,
  external: [PTY_PACKAGE],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: protocolAlias,
  define: {
    'process.env.THREADGARDEN_API_KEY_ONLY': JSON.stringify(apiKeyOnly ? '1' : ''),
    // Folded into the value above (and noted) here, at build time.
    'process.env.PAHUB_API_KEY_ONLY': JSON.stringify(''),
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

await copyPty().catch((err) => {
  process.stderr.write(`build: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
});

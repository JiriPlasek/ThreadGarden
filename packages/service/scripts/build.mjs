/**
 * Bundles the service into one ESM file, `dist/service.mjs`, that plain
 * `node --disable-warning=ExperimentalWarning dist/service.mjs` runs: release
 * builds ship it as the `service/service.mjs` resource next to the `threadgarden-node`
 * sidecar. Everything is inlined, the Agent SDK included: the SDK needs no
 * files beside its module at run time, because Threadgarden always passes
 * `pathToClaudeCodeExecutable` (its bundled-CLI lookup is never reached).
 * `require` is provided for the CommonJS dependencies (ws).
 *
 * `THREADGARDEN_API_KEY_ONLY=1` at build time makes an API-key-only build
 * (spec §5.5): the value is substituted into the bundle, not read when the
 * service runs. The legacy `PAHUB_API_KEY_ONLY=1` still works for one release
 * (spec v1.3 §9), with a deprecation note.
 */
import process from 'node:process';
import { build } from 'esbuild';

const legacyApiKeyOnly = process.env.PAHUB_API_KEY_ONLY;
if (legacyApiKeyOnly) {
  process.stderr.write(
    'PAHUB_API_KEY_ONLY is deprecated and will be ignored in a later release: set THREADGARDEN_API_KEY_ONLY instead\n',
  );
}
const apiKeyOnly = process.env.THREADGARDEN_API_KEY_ONLY === '1' || legacyApiKeyOnly === '1';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/service.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: {
    'process.env.THREADGARDEN_API_KEY_ONLY': JSON.stringify(apiKeyOnly ? '1' : ''),
    // Folded into the value above (and noted) here, at build time.
    'process.env.PAHUB_API_KEY_ONLY': JSON.stringify(''),
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

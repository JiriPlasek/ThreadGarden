/**
 * Bundles the service into one ESM file, `dist/service.mjs`, that plain
 * `node --disable-warning=ExperimentalWarning dist/service.mjs` runs: release
 * builds ship it as the `service/service.mjs` resource next to the `pahub-node`
 * sidecar. Everything is inlined, the Agent SDK included: the SDK needs no
 * files beside its module at run time, because pahub always passes
 * `pathToClaudeCodeExecutable` (its bundled-CLI lookup is never reached).
 * `require` is provided for the CommonJS dependencies (ws).
 *
 * `PAHUB_API_KEY_ONLY=1` at build time makes an API-key-only build (spec §5.5):
 * the value is substituted into the bundle, not read when the service runs.
 */
import process from 'node:process';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/service.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: {
    'process.env.PAHUB_API_KEY_ONLY': JSON.stringify(
      process.env.PAHUB_API_KEY_ONLY === '1' ? '1' : '',
    ),
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

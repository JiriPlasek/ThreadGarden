/**
 * Bundles the service into one ESM file, `dist/service.mjs`, that plain
 * `node --disable-warning=ExperimentalWarning dist/service.mjs` runs: release
 * builds ship it as the `service/service.mjs` resource next to the `pahub-node`
 * sidecar. Everything is inlined, the Agent SDK included: the SDK needs no
 * files beside its module at run time, because pahub always passes
 * `pathToClaudeCodeExecutable` (its bundled-CLI lookup is never reached).
 * `require` is provided for the CommonJS dependencies (ws).
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/service.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

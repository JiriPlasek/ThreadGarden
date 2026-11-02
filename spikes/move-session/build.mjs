/**
 * Bundles the throwaway move-session spike into one ESM file that plain Node
 * runs on either machine, with the service's esbuild settings
 * (packages/service/scripts/build.mjs). Run from packages/service so esbuild
 * and the Agent SDK resolve: `node ../../spikes/move-session/build.mjs`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'spike.ts')],
  outfile: path.join(here, 'dist', 'spike.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths: [path.resolve('node_modules'), path.resolve('../../node_modules')],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
console.log(`built ${path.join(here, 'dist', 'spike.mjs')}`);

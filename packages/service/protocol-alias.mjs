/**
 * `@threadgarden/protocol` resolved straight to its source, the entry its
 * package.json already names. The workspace link pnpm puts in node_modules is
 * then never followed, so the service's tests and build also run where links
 * cannot be followed (some sandboxed and agent environments on Windows).
 * Used by the vitest configs and scripts/build.mjs; tsconfig.base.json has the
 * matching `paths` entry for tsc and tsx.
 */
import { URL, fileURLToPath } from 'node:url';

export const protocolAlias = {
  '@threadgarden/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
};

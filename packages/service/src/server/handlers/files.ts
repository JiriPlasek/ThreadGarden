/** Router handler for `@` mention suggestions. */
import type { FileIndex } from '../../files/file-index.js';
import type { Router } from '../router.js';

export const registerFileHandlers = (router: Router, deps: { index: FileIndex }): void => {
  router.register('files.suggest', async (p) => deps.index.suggest(p.cwd, p.query, p.limit));
};

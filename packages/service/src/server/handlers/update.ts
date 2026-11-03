/**
 * Router handlers for updating (protocol 10). Only `update.latest` so far: the
 * newest release, asked of GitHub by this machine's own service.
 */
import type { LatestRelease } from '../../update/github.js';
import type { Router } from '../router.js';

export type UpdateHandlerDeps = {
  latest: LatestRelease;
};

export const registerUpdateHandlers = (router: Router, deps: UpdateHandlerDeps): void => {
  // Local only: a paired device asks its own machine's service, not this one.
  router.register('update.latest', async () => ({ version: await deps.latest.get() }), {
    localOnly: true,
  });
};

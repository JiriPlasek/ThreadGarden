/**
 * Router handlers for updating (protocol 10): the newest release, asked of GitHub
 * by this machine's own service, and this machine updating itself. `update.start`
 * and `update.status` are frozen, so any later desktop can still update this machine.
 */
import { UPDATE_ERRORS } from '@threadgarden/protocol';
import type { LatestRelease } from '../../update/github.js';
import type { Updater } from '../../update/updater.js';
import { ServiceError, type Router } from '../router.js';

export type UpdateHandlerDeps = {
  latest: LatestRelease;
  updater: Updater;
  /** Whether this service offers the `update` capability. */
  supported: () => boolean;
};

export const registerUpdateHandlers = (router: Router, deps: UpdateHandlerDeps): void => {
  // Local only: a paired device asks its own machine's service, not this one.
  router.register('update.latest', async () => ({ version: await deps.latest.get() }), {
    localOnly: true,
  });
  router.register('update.start', async (p) => {
    if (!deps.supported()) {
      throw new ServiceError(UPDATE_ERRORS.NOT_SUPPORTED, 'This machine cannot update itself');
    }
    return deps.updater.start(p.version, p.force);
  });
  router.register('update.status', async () => deps.updater.status());
};

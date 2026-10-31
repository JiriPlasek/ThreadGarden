/**
 * Router handlers for usage limits and scheduled sends (v1.3 B, spec §3):
 * `usage.get` and `scheduled.*`. The state lives in `UsageTracker` and
 * `ScheduledSends` (`usage/`); this only maps requests onto them.
 */
import type { ScheduledSends } from '../../usage/scheduled.js';
import type { UsageTracker } from '../../usage/usage.js';
import type { Router } from '../router.js';

export type UsageHandlerDeps = {
  usage: UsageTracker;
  scheduled: ScheduledSends;
  /** The usage reading of a running chat, when one runs (never starts a process). */
  reader: () => (() => Promise<unknown>) | undefined;
};

export const registerUsageHandlers = (router: Router, deps: UsageHandlerDeps): void => {
  const { usage, scheduled } = deps;

  router.register('usage.get', async (p) => {
    if (p.refresh === true) await usage.refresh(deps.reader());
    return usage.state();
  });

  router.register('scheduled.create', async (p) => scheduled.create(p));
  router.register('scheduled.list', async (p) => ({ items: scheduled.list(p.sessionId) }));
  router.register('scheduled.get', async (p) => scheduled.get(p.id));
  router.register('scheduled.update', async (p) => scheduled.update(p));
  router.register('scheduled.cancel', async (p) => {
    scheduled.cancel(p.id);
    return {};
  });
  router.register('scheduled.sendNow', async (p) => {
    await scheduled.sendNow(p.id);
    return {};
  });
};

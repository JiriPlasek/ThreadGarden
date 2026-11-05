import { z } from 'zod';
import type { AwayDeliverer } from '../../away/deliverer.js';
import { ServiceError, type Router } from '../router.js';

const uuid = z.string().uuid();

/**
 * Messages written for a machine that is away (protocol 11). Local only: they
 * are this desktop's own, never something a paired device may read or write.
 */
export const registerAwayHandlers = (
  router: Router,
  deps: {
    deliverer: Pick<AwayDeliverer, 'queue' | 'list' | 'cancel' | 'retry'>;
    machines: { get(id: string): unknown };
  },
): void => {
  const { deliverer } = deps;
  const local = { localOnly: true };
  router.register(
    'away.queue',
    async (p) => {
      // Rows for a machine that is not paired would wait forever.
      if (!deps.machines.get(p.machineId)) throw new ServiceError('NOT_FOUND', 'No such machine');
      if (p.kind === 'create') {
        if (p.cwd === undefined) {
          throw new ServiceError('INVALID_PARAMS', 'A new chat needs its folder');
        }
        // The machine makes the chat with this id: it must take it (`chat.create`'s sessionId).
        if (!uuid.safeParse(p.sessionId).success) {
          throw new ServiceError('INVALID_PARAMS', "A new chat's id must be a UUID");
        }
      }
      return deliverer.queue(p);
    },
    local,
  );
  router.register('away.list', async ({ machineId }) => deliverer.list(machineId), local);
  router.register(
    'away.cancel',
    async ({ id }) => {
      deliverer.cancel(id);
      return {};
    },
    local,
  );
  router.register(
    'away.retry',
    async ({ machineId }) => {
      deliverer.retry(machineId);
      return {};
    },
    local,
  );
};

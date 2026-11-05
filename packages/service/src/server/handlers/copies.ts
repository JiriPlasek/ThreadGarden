import type { CopyStore } from '../../away/copies.js';
import type { Router } from '../router.js';

/**
 * The desktop's copies of its paired machines (protocol 11). Local only: they
 * are this desktop's own, never something a paired device may read or write.
 */
export const registerCopyHandlers = (router: Router, deps: { store: CopyStore }): void => {
  const { store } = deps;
  const local = { localOnly: true };
  router.register(
    'copies.saveLists',
    async (p) => {
      store.saveLists(p);
      return {};
    },
    local,
  );
  router.register(
    'copies.saveChat',
    async (p) => {
      store.saveChat(p);
      return {};
    },
    local,
  );
  router.register('copies.get', async ({ machineId }) => store.get(machineId), local);
  router.register(
    'copies.chat',
    async ({ machineId, sessionId }) => store.chat(machineId, sessionId),
    local,
  );
  router.register('copies.tails', async ({ machineId }) => store.tails(machineId), local);
};

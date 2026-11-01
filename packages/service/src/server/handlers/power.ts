/**
 * Router handlers for power control on the desktop's side (protocol 6): the
 * switch is reached from this machine's service, so all of them are local only.
 * The state lives in `PowerHub` (`power/hub.ts`); passwords are never returned.
 */
import type { PowerHub } from '../../power/hub.js';
import type { Router } from '../router.js';

export const registerPowerClientHandlers = (router: Router, deps: { hub: PowerHub }): void => {
  const { hub } = deps;
  const local = { localOnly: true };

  router.register('power.probe', async (p) => hub.probe(p.address, p.password), local);
  router.register('power.pairPlug', async (p) => hub.pairPlug(p.address, p.password), local);
  router.register(
    'power.rename',
    async (p) => {
      await hub.rename(p.address, p.password, p.id, p.name);
      return {};
    },
    local,
  );
  router.register('power.configure', async (p) => hub.configure(p.machineId, p.config, p.password), local);
  router.register(
    'power.unlock',
    async (p) => {
      hub.unlock(p.machineId, p.password);
      return {};
    },
    local,
  );
  router.register('power.list', async () => hub.list(), local);
  router.register('power.reading', async (p) => hub.reading(p.machineId), local);
  router.register('power.turnOn', async (p) => hub.turnOn(p.machineId), local);
  router.register(
    'power.noteMeasurement',
    async (p) => {
      hub.noteMeasurement(p.machineId, p.kind, p.watts);
      return {};
    },
    local,
  );
};

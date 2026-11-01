/**
 * Router handlers for power control on the desktop's side (protocol 6): the
 * switch is reached from this machine's service, so all of them are local only.
 * The state lives in `PowerHub` (`power/hub.ts`); passwords are never returned.
 */
import {
  POWER_ERRORS,
  PowerConfigSchema,
  type MachinePowerStatus,
} from '@threadgarden/protocol';
import type { PowerHub } from '../../power/hub.js';
import type { IdleMonitor } from '../../power/idle.js';
import type { PowerStore } from '../../power/store.js';
import { PowerError } from '../../power/tasmota.js';
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

/** What the machine-side handlers need; `emit` reaches every client, local and paired. */
export type PowerMachineDeps = {
  store: PowerStore;
  idle: IdleMonitor;
  emit: (e: { event: 'power.changed'; data: MachinePowerStatus }) => void;
};

/**
 * `power.adopt`, `power.status` and `power.keepAwake` on a headless machine: open to
 * paired devices. Every change is announced as `power.changed`. The status never
 * carries the password. `notify` announces a change that happened on its own (the
 * minute tick: busy, idle since, a keep awake that ran out).
 */
export const registerPowerMachineHandlers = (
  router: Router,
  deps: PowerMachineDeps,
): { status: () => MachinePowerStatus; notify: () => void } => {
  const { store, idle } = deps;
  let last = '';

  const status = (): MachinePowerStatus => {
    idle.tick();
    return {
      configured: store.load() !== null,
      busy: idle.busy,
      idleSince: idle.idleSince,
      shutsDownAt: idle.shutsDownAt(),
      keepAwake: idle.keepAwake,
      phase: 'running',
      unpushed: [],
      problem: null,
    };
  };
  const announce = (): MachinePowerStatus => {
    const s = status();
    last = JSON.stringify(s);
    deps.emit({ event: 'power.changed', data: s });
    return s;
  };
  const notify = (): void => {
    if (JSON.stringify(status()) !== last) announce();
  };

  router.register('power.status', async () => {
    const s = status();
    last = JSON.stringify(s);
    return s;
  });
  router.register('power.adopt', async (p) => {
    if (p.config === null) {
      store.save(null);
    } else {
      const config = PowerConfigSchema.parse(p.config);
      const password = p.password ?? store.load()?.password;
      if (password === undefined) {
        throw new PowerError(POWER_ERRORS.notConfigured, 'The switch needs its password.');
      }
      store.save(config, password);
    }
    announce();
    return {};
  });
  router.register('power.keepAwake', async (p) => {
    idle.setKeepAwake(p);
    return announce();
  });
  return { status, notify };
};

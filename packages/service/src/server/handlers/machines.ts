import { RELAY_CLOSE, type EventMsg, type MachineInfo } from '@threadgarden/protocol';
import type { Db } from '../../history/db.js';
import type { DeviceRegistry } from '../../machine/devices.js';
import { renameMachine } from '../../machine/identity.js';
import type { PairedMachines } from '../../machine/paired-machines.js';
import { pairWithMachine, unpairFromMachine } from '../../machine/pairing-client.js';
import type { TlsIdentity } from '../../machine/tls.js';
import type { Relay } from '../relay.js';
import { REMOTE_PORT } from '../remote-server.js';
import { ServiceError, type HandlerCtx, type Router } from '../router.js';

const PAIRING_MESSAGES = {
  PAIRING_INVALID: 'The pairing code is not valid',
  PAIRING_EXPIRED: 'The pairing code has expired',
} as const;

/**
 * This machine as the caller may see it: before authentication (a pairing
 * socket: remote, no device) the home folder is withheld.
 */
export const machineFor = (ctx: HandlerCtx, machine: MachineInfo): MachineInfo =>
  ctx.origin === 'remote' && ctx.deviceId === undefined ? { ...machine, home: '' } : machine;

/**
 * This machine, the devices paired with it and pairing. Creating codes,
 * listing and revoking devices and renaming the machine are local only;
 * `pair.proof` and `pair.claim` are what a device being paired may call.
 */
export const registerMachineHandlers = (
  router: Router,
  deps: {
    db: Db;
    devices: DeviceRegistry;
    /** This machine as it is now (its name changes on rename). */
    identity: () => MachineInfo;
    /** The remote listener's certificate; without it there is nothing to prove. */
    tls?: TlsIdentity;
    onRenamed?: (machine: MachineInfo) => void;
    /** Machines this one connects to (`machines.*`); none without it. */
    paired?: PairedMachines;
    /** Their relays, closed when a machine moves or goes. */
    relay?: Pick<Relay, 'drop'>;
    /** Sends an event to this machine's own clients only (never to paired devices). */
    emitLocal?: (e: EventMsg) => void;
    /** Pairing, injectable for tests. */
    pair?: typeof pairWithMachine;
    unpair?: typeof unpairFromMachine;
    now?: () => number;
  },
): void => {
  const { devices, identity } = deps;

  router.register('machine.get', async (_p, ctx) => machineFor(ctx, identity()));
  router.register(
    'machine.rename',
    async ({ name }) => {
      renameMachine(deps.db, name);
      const machine = identity();
      deps.onRenamed?.(machine);
      return machine;
    },
    { localOnly: true },
  );

  router.register('pairing.create', async () => devices.createPairingCode(), { localOnly: true });
  router.register('devices.list', async () => devices.list(), { localOnly: true });
  // Revocable from either side: locally any device, by a paired device only itself.
  router.register('devices.revoke', async ({ deviceId }, ctx) => {
    if (ctx.origin !== 'local' && (ctx.deviceId === undefined || ctx.deviceId !== deviceId)) {
      throw new ServiceError('FORBIDDEN', 'A device may only revoke itself');
    }
    return { revoked: devices.revoke(deviceId) };
  });

  router.register('pair.proof', async ({ nonce }, ctx) => {
    if (!deps.tls) throw new ServiceError('NOT_LISTENING', 'This machine does not accept devices');
    return {
      proof: devices.proof(deps.tls.fingerprint256, nonce),
      machine: machineFor(ctx, identity()),
    };
  });
  // A successful claim authenticates the caller: it gets the machine as it is.
  router.register('pair.claim', async ({ code, deviceName }) => {
    const claimed = devices.claim(code, deviceName);
    if ('error' in claimed) throw new ServiceError(claimed.error, PAIRING_MESSAGES[claimed.error]);
    return { ...claimed, machine: identity() };
  });
  if (deps.paired) registerPairedMachineHandlers(router, { ...deps, paired: deps.paired });
};

/** `machines.*`: the machines this one pairs with and relays to. All local only. */
const registerPairedMachineHandlers = (
  router: Router,
  deps: Parameters<typeof registerMachineHandlers>[1] & { paired: PairedMachines },
): void => {
  const { paired } = deps;
  const pair = deps.pair ?? pairWithMachine;
  const unpair = deps.unpair ?? unpairFromMachine;
  const now = deps.now ?? Date.now;
  const changed = (): void => deps.emitLocal?.({ event: 'machines.changed', data: paired.list() });
  const known = (machineId: string) => {
    const m = paired.get(machineId);
    if (!m) throw new ServiceError('NOT_FOUND', 'No such machine');
    return m;
  };
  const listed = (machineId: string) => paired.list().find((m) => m.id === machineId)!;
  const local = { localOnly: true };

  router.register('machines.list', async () => paired.list(), local);

  router.register(
    'machines.pair',
    async ({ address, port = REMOTE_PORT, code, deviceName }) => {
      /** Refuses this machine itself and one already paired, before the code is sent. */
      const refuse = (machine: MachineInfo): void => {
        if (machine.id === deps.identity().id) {
          throw new ServiceError('PAIRING_SELF', 'This is this machine');
        }
        const existing = paired.get(machine.id);
        if (existing)
          throw new ServiceError('PAIRING_DUPLICATE', `Already paired as ${existing.name}`);
      };
      const result = await pair({ address, port, code, deviceName, accept: refuse });
      // Checked again: another pairing with the same machine may have finished meanwhile.
      refuse(result.machine);
      paired.add({
        id: result.machine.id,
        name: result.machine.name,
        address,
        port,
        certPem: result.certPem,
        fingerprint: result.fingerprint,
        deviceId: result.deviceId,
        addedAt: now(),
      });
      paired.unlock(result.machine.id, result.token);
      changed();
      return { machine: listed(result.machine.id), token: result.token };
    },
    local,
  );

  router.register(
    'machines.unlock',
    async ({ machineId, token }) => {
      known(machineId);
      const was = paired.token(machineId);
      paired.unlock(machineId, token);
      if (was !== token) changed();
      return {};
    },
    local,
  );

  router.register(
    'machines.update',
    async ({ machineId, name, address, port }) => {
      const before = known(machineId);
      const updated = paired.update(machineId, {
        ...(name === undefined ? {} : { name }),
        ...(address === undefined ? {} : { address }),
        ...(port === undefined ? {} : { port }),
      });
      // Relays to the old address end; the UI reconnects to the new one (same pin).
      if (updated.address !== before.address || updated.port !== before.port) {
        deps.relay?.drop(machineId, RELAY_CLOSE.unreachable);
      }
      changed();
      return updated;
    },
    local,
  );

  router.register(
    'machines.remove',
    async ({ machineId, revoke }) => {
      const machine = paired.get(machineId);
      if (!machine) return {};
      deps.relay?.drop(machineId, RELAY_CLOSE.locked);
      const token = paired.token(machineId);
      // Best effort: the machine forgets this device if it can be reached (needs the token).
      if (revoke && token !== null) {
        await unpair({
          address: machine.address,
          port: machine.port,
          pin: { certPem: machine.certPem, fingerprint: machine.fingerprint },
          token,
          deviceId: machine.deviceId,
        });
      }
      paired.remove(machineId);
      changed();
      return {};
    },
    local,
  );
};

import type { MachineInfo } from '@threadgarden/protocol';
import type { Db } from '../../history/db.js';
import type { DeviceRegistry } from '../../machine/devices.js';
import { renameMachine } from '../../machine/identity.js';
import type { TlsIdentity } from '../../machine/tls.js';
import { ServiceError, type Router } from '../router.js';

const PAIRING_MESSAGES = {
  PAIRING_INVALID: 'The pairing code is not valid',
  PAIRING_EXPIRED: 'The pairing code has expired',
} as const;

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
  },
): void => {
  const { devices, identity } = deps;

  router.register('machine.get', async () => identity());
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
  router.register(
    'devices.revoke',
    async ({ deviceId }) => ({ revoked: devices.revoke(deviceId) }),
    { localOnly: true },
  );

  router.register('pair.proof', async ({ nonce }) => {
    if (!deps.tls) throw new ServiceError('NOT_LISTENING', 'This machine does not accept devices');
    return { proof: devices.proof(deps.tls.fingerprint256, nonce), machine: identity() };
  });
  router.register('pair.claim', async ({ code, deviceName }) => {
    const claimed = devices.claim(code, deviceName);
    if ('error' in claimed) throw new ServiceError(claimed.error, PAIRING_MESSAGES[claimed.error]);
    return { ...claimed, machine: identity() };
  });
};

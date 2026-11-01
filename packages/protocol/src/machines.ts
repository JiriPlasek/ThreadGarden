import { z } from 'zod';

/**
 * The protocol versions a desktop accepts from a remote service: its own, one
 * older and one newer. A local service must match exactly.
 */
export const REMOTE_PROTOCOL_RANGE = { min: 5, max: 7 } as const;

export const acceptsRemoteProtocol = (v: number): boolean =>
  Number.isInteger(v) && v >= REMOTE_PROTOCOL_RANGE.min && v <= REMOTE_PROTOCOL_RANGE.max;

/**
 * What every service can do for a remote desktop. Later plans add `projects` and `move`.
 * `power` is not here: a headless service adds it to its own `hello` at runtime.
 */
export const CAPABILITIES = ['remote'] as const;

export const MachineInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  headless: z.boolean(),
  home: z.string(),
  capabilities: z.array(z.string()),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

/** A desktop paired with this (headless) service. The token is never part of it. */
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeen: z.number().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * A machine this one pairs with and connects to (through the relay). Its
 * certificate is pinned by `fingerprint`; the device token is never part of it.
 * `unlocked`: the service holds the token now (in memory: the UI hands it over
 * from the keychain with `machines.unlock` after every service start).
 */
export const PairedMachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  port: z.number(),
  fingerprint: z.string(),
  addedAt: z.number(),
  unlocked: z.boolean(),
});
export type PairedMachine = z.infer<typeof PairedMachineSchema>;

/** Where a paired machine's listener is: an IP address or a host name (`ubuntu-pc.local`). */
export const MachineAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, 'An IP address or a host name');
export const MachinePortSchema = z.number().int().min(1).max(65535);
/** A device token: 32 random bytes as hex. */
export const DeviceTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * How the local relay (`/relay?machine=<id>`) closes the UI's socket:
 * `locked` the machine is unknown or its token was not handed over;
 * `mismatch` a different certificate answered at the address (nothing was
 * sent to it); `refused` the machine refused the token (revoked);
 * `unreachable` the machine could not be reached or the link dropped (retry).
 */
export const RELAY_CLOSE = {
  locked: 4404,
  mismatch: 4409,
  refused: 4403,
  unreachable: 4502,
} as const;

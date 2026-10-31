import { z } from 'zod';

/**
 * The protocol versions a desktop accepts from a remote service: its own, one
 * older and one newer. A local service must match exactly.
 */
export const REMOTE_PROTOCOL_RANGE = { min: 4, max: 6 } as const;

export const acceptsRemoteProtocol = (v: number): boolean =>
  Number.isInteger(v) && v >= REMOTE_PROTOCOL_RANGE.min && v <= REMOTE_PROTOCOL_RANGE.max;

/** What a service can do for a remote desktop. Later plans add `projects`, `move` and `power`. */
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

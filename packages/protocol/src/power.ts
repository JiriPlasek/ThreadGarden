import { z } from 'zod';

/** Advertised in `hello` by a machine that can be switched off and on (headless, with a power switch). */
export const POWER_CAPABILITY = 'power';

/** The oldest Tasmota the docs promise the commands Threadgarden uses for. */
export const MIN_TASMOTA = '14.0.0';

export const PowerKindSchema = z.enum(['tasmota-zigbee', 'tasmota-plug']);
export type PowerKind = z.infer<typeof PowerKindSchema>;

/** How a machine's power switch is reached. `device` is the Zigbee name, `null` for a Wi-Fi plug. */
export const PowerConfigSchema = z.object({
  kind: PowerKindSchema,
  address: z.string().min(1),
  device: z.string().nullable(),
  /** Below this many watts the PC counts as off. */
  offWatts: z.number().min(0.5).max(100).default(5),
  minOffSeconds: z.number().int().min(10).max(600).default(90),
  measured: z
    .object({ running: z.number().nullable(), standby: z.number().nullable() })
    .default({ running: null, standby: null }),
});
export type PowerConfig = z.infer<typeof PowerConfigSchema>;

export const PlugReadingSchema = z.object({
  on: z.boolean().nullable(),
  watts: z.number().nullable(),
  at: z.number(),
});
export type PlugReading = z.infer<typeof PlugReadingSchema>;

export const SwitchDeviceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  on: z.boolean().nullable(),
  watts: z.number().nullable(),
  metering: z.boolean(),
});
export type SwitchDevice = z.infer<typeof SwitchDeviceSchema>;

export const ProbeResultSchema = z.object({
  version: z.string(),
  kind: PowerKindSchema,
  devices: z.array(SwitchDeviceSchema),
  plug: PlugReadingSchema.nullable(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const UnpushedSchema = z.object({
  repo: z.string(),
  branch: z.string().nullable(),
  kind: z.enum(['uncommitted', 'unpushed']),
  count: z.number().int(),
  sessionId: z.string().nullable(),
});
export type Unpushed = z.infer<typeof UnpushedSchema>;

export const KeepAwakeSchema = z.object({
  mode: z.enum(['off', 'always', 'until']),
  until: z.number().nullable(),
});
export type KeepAwake = z.infer<typeof KeepAwakeSchema>;

export const MachinePowerStatusSchema = z.object({
  configured: z.boolean(),
  busy: z.boolean(),
  idleSince: z.number().nullable(),
  shutsDownAt: z.number().nullable(),
  keepAwake: KeepAwakeSchema,
  phase: z.enum(['running', 'checking', 'blocked', 'shuttingDown']),
  unpushed: z.array(UnpushedSchema),
  problem: z.string().nullable(),
});
export type MachinePowerStatus = z.infer<typeof MachinePowerStatusSchema>;

export const POWER_ERRORS = {
  unreachable: 'POWER_UNREACHABLE',
  auth: 'POWER_AUTH',
  notTasmota: 'POWER_NOT_TASMOTA',
  tooOld: 'POWER_TOO_OLD',
  refused: 'POWER_REFUSED',
  noMetering: 'POWER_NO_METERING',
  conflict: 'POWER_CONFLICT',
  notConfigured: 'POWER_NOT_CONFIGURED',
} as const;

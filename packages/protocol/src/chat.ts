import { z } from 'zod';

export const ChatStatusSchema = z.enum([
  'needsYou',
  'working',
  'idle',
  'paused',
  'failed',
  'history',
  'unknown',
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const ExternalInfoSchema = z.object({
  shortId: z.string().optional(),
  kind: z.string(),
  state: z.string().optional(),
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  pid: z.number().optional(),
  name: z.string().optional(),
});
export type ExternalInfo = z.infer<typeof ExternalInfoSchema>;

export const ChatSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  status: ChatStatusSchema,
  preview: z.string(),
  lastActivity: z.number(),
  pinned: z.boolean(),
  live: z.boolean(),
  external: ExternalInfoSchema.nullable(),
  waitingFor: z.string().optional(),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

export const ProjectSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  displayName: z.string(),
  pinned: z.boolean(),
  hidden: z.boolean(),
  lastActivity: z.number(),
  counts: z.object({ needsYou: z.number(), running: z.number() }),
});
export type Project = z.infer<typeof ProjectSchema>;

export const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('needsYou') }),
  z.object({ kind: z.literal('running') }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
]);
export type Place = z.infer<typeof PlaceSchema>;

export const ChatHeaderInfoSchema = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  claudeVersion: z.string().optional(),
  auth: z
    .object({ kind: z.enum(['subscription', 'apiKey', 'other']), label: z.string() })
    .optional(),
  contextUsage: z.object({ used: z.number(), max: z.number() }).optional(),
  costUsd: z.number().optional(),
});
export type ChatHeaderInfo = z.infer<typeof ChatHeaderInfoSchema>;

const settingsFields = {
  claudePath: z.string().nullable(),
  idleReclaimMinutes: z.number(),
  notifications: z.boolean(),
  enterToSend: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  startOnLogin: z.boolean(),
  externalPolling: z.boolean(),
};

export const SettingsSchema = z.object({
  claudePath: settingsFields.claudePath.default(null),
  idleReclaimMinutes: settingsFields.idleReclaimMinutes.default(15),
  notifications: settingsFields.notifications.default(true),
  enterToSend: settingsFields.enterToSend.default(true),
  theme: settingsFields.theme.default('system'),
  startOnLogin: settingsFields.startOnLogin.default(false),
  externalPolling: settingsFields.externalPolling.default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Partial update payload; unlike SettingsSchema it never injects defaults. */
export const SettingsPatchSchema = z.object(settingsFields).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const settingsDefaults: Settings = SettingsSchema.parse({});

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

// ── v1.2 B1: buckets ──────────────────────────────────────────────────────────

/**
 * v1.2: every chat is in exactly one bucket — pahub's own metadata, never
 * written into Claude Code's data. `active` is the default.
 */
export const BucketSchema = z.enum(['active', 'onHold', 'archived']);
export type Bucket = z.infer<typeof BucketSchema>;

/** Most characters of an on-hold note ("waiting for review from Petr"). */
export const HOLD_NOTE_MAX = 200;

// ──────────────────────────────────────────────────────────────────────────────

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
  /**
   * v1.1 "Your turn": a turn ended since the chat was last seen, and it is
   * neither waiting on the user nor working (pahub-side state, never Claude Code's).
   */
  unread: z.boolean().default(false),
  /**
   * Ruling R29: background tasks (agents, processes) running in a live pahub
   * chat; absent when none. Such a chat counts as Running even while its turn
   * is idle (its status stays idle).
   */
  runningTasks: z.number().int().nonnegative().optional(),
  // ── v1.2 B1: buckets ──
  /** The chat's bucket; a value this version does not know reads as `active`. */
  bucket: BucketSchema.default('active').catch('active'),
  /** On hold until this time (epoch ms); absent when on hold indefinitely or not on hold. */
  holdUntil: z.number().optional(),
  /** The on-hold note; absent when none or not on hold. */
  holdNote: z.string().optional(),
  /**
   * The hold timer ran out: the chat is back in Active and listed under Needs
   * you (after the chats waiting on the user, alongside unread ones) until it
   * is seen (`chat.markSeen`) or sent a message. Like `unread`, false while the
   * chat waits on the user or works.
   */
  backFromHold: z.boolean().default(false),
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
  /** v1.1: whether the project folder exists on disk (cached stat; "Missing folders" when false). */
  exists: z.boolean().default(true),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A place in the left column. v1.2: `active`, `onHold` and `archived` list
 * the chats of one bucket (hidden projects left out, like `all` was). `all`
 * stays accepted as an alias of `active`, so stored UI state and older UIs
 * keep working. A project lists its active chats; `include` adds the chats of
 * other buckets. Needs you and Running span every bucket.
 */
export const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('needsYou') }),
  z.object({ kind: z.literal('running') }),
  /** Alias of `active` (v1.2). */
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('project'),
    projectId: z.string(),
    /** v1.2: other buckets to list too (default: active chats only). */
    include: z.array(z.enum(['onHold', 'archived'])).optional(),
  }),
  // ── v1.2 B1: buckets ──
  z.object({ kind: z.literal('active') }),
  z.object({ kind: z.literal('onHold') }),
  z.object({ kind: z.literal('archived') }),
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
  /** v1.1: desktop notification when a chat finishes a turn while not looked at. */
  notifyOnFinish: z.boolean(),
};

export const SettingsSchema = z.object({
  claudePath: settingsFields.claudePath.default(null),
  idleReclaimMinutes: settingsFields.idleReclaimMinutes.default(15),
  notifications: settingsFields.notifications.default(true),
  enterToSend: settingsFields.enterToSend.default(true),
  theme: settingsFields.theme.default('system'),
  startOnLogin: settingsFields.startOnLogin.default(false),
  externalPolling: settingsFields.externalPolling.default(true),
  notifyOnFinish: settingsFields.notifyOnFinish.default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Partial update payload; unlike SettingsSchema it never injects defaults. */
export const SettingsPatchSchema = z.object(settingsFields).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const settingsDefaults: Settings = SettingsSchema.parse({});

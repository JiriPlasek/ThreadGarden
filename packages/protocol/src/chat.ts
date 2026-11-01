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
 * v1.2: every chat is in exactly one bucket — Threadgarden's own metadata, never
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
   * neither waiting on the user nor working (Threadgarden-side state, never Claude Code's).
   */
  unread: z.boolean().default(false),
  /**
   * Ruling R29: background tasks (agents, processes) running in a live Threadgarden
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

// ── v1.3 E: appearance ──
/** Accent colours; `graphite` is the neutral look Threadgarden had before v1.3 and stays the default. */
export const ACCENTS = ['graphite', 'blue', 'teal', 'green', 'violet', 'rose', 'amber'] as const;
export const DARK_STYLES = ['default', 'dim', 'midnight'] as const;
export const LIGHT_STYLES = ['default', 'warm'] as const;
/** `inter` is the bundled Inter Variable; `system` the platform's UI font. */
export const UI_FONTS = ['inter', 'system'] as const;
/** Longest code font value a patch may carry (before sanitising). */
export const CODE_FONT_MAX = 256;
const FONT_NAME_MAX = 64;
const FONT_NAMES_MAX = 4;

/**
 * Reduces a user-typed font family list to names that are safe inside a
 * double-quoted CSS string: letters, digits, spaces, `_`, `-` and `.` only
 * (quotes, backslashes, semicolons, braces, slashes and control characters
 * become spaces), at most four comma-separated names of 64 characters.
 * Returns null when nothing usable is left.
 */
export const sanitizeFontFamily = (raw: string): string | null => {
  const names = raw
    .split(',')
    .map((n) =>
      n
        .replace(/[^\p{L}\p{N} _.-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, FONT_NAME_MAX)
        .trim(),
    )
    .filter((n) => n.length > 0)
    .slice(0, FONT_NAMES_MAX);
  return names.length > 0 ? names.join(', ') : null;
};

const settingsFields = {
  claudePath: z.string().nullable(),
  idleReclaimMinutes: z.number(),
  /** v1.4 power: a headless machine shuts down after this many idle minutes; null is never. */
  idleShutdownMinutes: z.number().int().min(5).max(1440).nullable(),
  notifications: z.boolean(),
  enterToSend: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  startOnLogin: z.boolean(),
  externalPolling: z.boolean(),
  /** v1.1: desktop notification when a chat finishes a turn while not looked at. */
  notifyOnFinish: z.boolean(),
  // ── v1.2 C1: chat titles ──
  /**
   * Name new chats automatically: after a chat's first turn a small model
   * (Claude Code's `haiku`) suggests a short title, shown until the user
   * renames the chat. Off: the chat keeps its provisional title (its first
   * sentence).
   */
  autoTitles: z.boolean(),
  // ── v1.3 E: appearance ──
  /** Drives the primary, ring and selection colours in both themes. */
  accent: z.enum(ACCENTS),
  /** Surfaces of the dark theme: today's, a softer grey, or true black (OLED). */
  darkStyle: z.enum(DARK_STYLES),
  /** Surfaces of the light theme: today's white, or a warm paper tint. */
  lightStyle: z.enum(LIGHT_STYLES),
  uiFont: z.enum(UI_FONTS),
  /** A custom code font family list (sanitised, see `sanitizeFontFamily`); null is the default monospace stack. */
  codeFont: z
    .string()
    .max(CODE_FONT_MAX)
    .nullable()
    .transform((v) => (v === null ? null : sanitizeFontFamily(v))),
};

export const SettingsSchema = z.object({
  claudePath: settingsFields.claudePath.default(null),
  idleReclaimMinutes: settingsFields.idleReclaimMinutes.default(15),
  idleShutdownMinutes: settingsFields.idleShutdownMinutes.default(60),
  notifications: settingsFields.notifications.default(true),
  enterToSend: settingsFields.enterToSend.default(true),
  theme: settingsFields.theme.default('system'),
  startOnLogin: settingsFields.startOnLogin.default(false),
  externalPolling: settingsFields.externalPolling.default(true),
  notifyOnFinish: settingsFields.notifyOnFinish.default(true),
  // ── v1.2 C1: chat titles ──
  autoTitles: settingsFields.autoTitles.default(true),
  // ── v1.3 E: appearance ──
  // Read leniently (`.catch`): a stored value this build does not know (a newer
  // accent, a corrupt row) reads as the default instead of failing the object.
  accent: settingsFields.accent.catch('graphite'),
  darkStyle: settingsFields.darkStyle.catch('default'),
  lightStyle: settingsFields.lightStyle.catch('default'),
  uiFont: settingsFields.uiFont.catch('inter'),
  // Any length reads: the value is sanitised (and capped) anyway.
  codeFont: z
    .string()
    .nullable()
    .transform((v) => (v === null ? null : sanitizeFontFamily(v)))
    .catch(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Partial update payload; unlike SettingsSchema it never injects defaults. */
export const SettingsPatchSchema = z.object(settingsFields).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const settingsDefaults: Settings = SettingsSchema.parse({});

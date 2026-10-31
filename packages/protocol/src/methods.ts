import { z } from 'zod';
import { AnalyticsRangeSchema, AnalyticsSchema } from './analytics.js';
import {
  BucketSchema,
  ChatHeaderInfoSchema,
  HOLD_NOTE_MAX,
  ChatSummarySchema,
  PlaceSchema,
  ProjectSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './chat.js';
import { ChatItemsEventSchema, ChatStatusEventSchema, ChatTasksEventSchema } from './events.js';
import { ChatItemSchema, ImageRefSchema } from './items.js';
import {
  DeviceSchema,
  DeviceTokenSchema,
  MachineAddressSchema,
  MachineInfoSchema,
  MachinePortSchema,
  PairedMachineSchema,
} from './machines.js';
import { ChatTaskSchema } from './tasks.js';
import { ScheduledSendSchema, UsageStateSchema } from './usage.js';

const empty = z.object({});
const sessionIdOnly = z.object({ sessionId: z.string() });
const setValue = z.object({ sessionId: z.string(), value: z.string() });
const lookupScope = z.object({ sessionId: z.string().optional(), cwd: z.string().optional() });

const scheduledId = z.object({ id: z.string() });
/** A scheduled send's time: a moment, or when the usage limit resets (plus a margin). */
const when = {
  sendAt: z.number().optional(),
  whenLimitResets: z.literal(true).optional(),
};

const def = <P extends z.ZodType, R extends z.ZodType>(params: P, result: R) => ({
  params,
  result,
});

export const methods = {
  hello: def(
    z.object({ protocolVersion: z.number(), client: z.string() }),
    z.object({
      serviceVersion: z.string(),
      protocolVersion: z.number(),
      /** Optional so a protocol-4 service still parses. */
      machine: MachineInfoSchema.optional(),
    }),
  ),
  /** v1.4: this machine's identity. */
  'machine.get': def(empty, MachineInfoSchema),
  'machine.rename': def(z.object({ name: z.string().trim().min(1).max(40) }), MachineInfoSchema),
  /** v1.4, local only: a one-time code (`XXXX-XXXX-XXXX`, 5 minutes) that pairs one device. */
  'pairing.create': def(empty, z.object({ code: z.string(), expiresAt: z.number() })),
  /** v1.4, local only: the devices paired with this machine. */
  'devices.list': def(empty, z.array(DeviceSchema)),
  /**
   * v1.4: unpairs a device; its open connections close with 4403. Local
   * callers may revoke any device; a paired device only itself (`FORBIDDEN`
   * otherwise), so it can be unpaired from either side.
   */
  'devices.revoke': def(z.object({ deviceId: z.string() }), z.object({ revoked: z.boolean() })),
  /**
   * v1.4, pairing: HMAC-SHA256 of `<certificate fingerprint>
<nonce>` keyed by
   * the live pairing code, so the client can check it reached the machine that
   * showed the code before sending it. `proof` is null when no code is live.
   */
  'pair.proof': def(
    z.object({ nonce: z.string().regex(/^[0-9a-f]{64}$/) }),
    z.object({ proof: z.string().nullable(), machine: MachineInfoSchema }),
  ),
  /** v1.4, pairing: spends the code on a device token. Errors: `PAIRING_INVALID`, `PAIRING_EXPIRED`. */
  'pair.claim': def(
    z.object({ code: z.string().max(64), deviceName: z.string().trim().min(1).max(60) }),
    z.object({ deviceId: z.string(), token: z.string(), machine: MachineInfoSchema }),
  ),
  // ── v1.4: machines this one connects to (all local only) ──────────────────
  /** The paired machines, in their order. */
  'machines.list': def(empty, z.array(PairedMachineSchema)),
  /**
   * Pairs with the machine at `address` (default port 47380) with the code it
   * showed: the code is sent only once the machine proved it knows it for the
   * certificate it presented, which is then pinned. Stores the machine and
   * unlocks it; the token is returned this once, for the keychain. Errors:
   * `PAIRING_UNREACHABLE`, `PAIRING_PROOF_FAILED` (nothing was sent: a wrong
   * code or another machine at the address), `PAIRING_INVALID`,
   * `PAIRING_EXPIRED`, `PAIRING_SELF` (this machine), `PAIRING_DUPLICATE`
   * (already paired; the message names it).
   */
  'machines.pair': def(
    z.object({
      address: MachineAddressSchema,
      port: MachinePortSchema.optional(),
      code: z.string().max(64),
      deviceName: z.string().trim().min(1).max(60),
    }),
    z.object({ machine: PairedMachineSchema, token: z.string() }),
  ),
  /** Hands over a machine's token (from the keychain); in memory until the service stops. `NOT_FOUND`. */
  'machines.unlock': def(z.object({ machineId: z.string(), token: DeviceTokenSchema }), empty),
  /** Renames or moves a machine; the pin stays. A move closes its relays (4502). `NOT_FOUND`. */
  'machines.update': def(
    z.object({
      machineId: z.string(),
      name: z.string().trim().min(1).max(40).optional(),
      address: MachineAddressSchema.optional(),
      port: MachinePortSchema.optional(),
    }),
    PairedMachineSchema,
  ),
  /**
   * Forgets a machine (its relays close with 4404). With `revoke`, it then
   * asks the machine to revoke this device, when reachable; a failure is
   * ignored. `revoked`: the machine confirmed it (false when not asked: no
   * `revoke`, the machine locked or unknown, or it could not be reached).
   */
  'machines.remove': def(
    z.object({ machineId: z.string(), revoke: z.boolean() }),
    z.object({ revoked: z.boolean() }),
  ),
  /** v1.2: `active`, `onHold`, `archived` per bucket; `all` (= `active`) stays for older UIs. */
  'places.counts': def(
    empty,
    z.object({
      needsYou: z.number(),
      running: z.number(),
      all: z.number(),
      active: z.number(),
      onHold: z.number(),
      archived: z.number(),
    }),
  ),
  'projects.list': def(empty, z.array(ProjectSchema)),
  'projects.update': def(
    z.object({
      projectId: z.string(),
      pinned: z.boolean().optional(),
      hidden: z.boolean().optional(),
    }),
    empty,
  ),
  /**
   * v1.3: the project's icon (its favicon or logo, found in the project
   * folder) as a `data:` URL, or null when it has none or its folder is gone.
   * Cached by the service; ask lazily, for the projects on screen.
   */
  'projects.icon': def(
    z.object({ projectId: z.string() }),
    z.object({ dataUrl: z.string().nullable() }),
  ),
  'sessions.list': def(
    z.object({
      place: PlaceSchema,
      query: z.string().optional(),
      limit: z.number(),
      cursor: z.string().optional(),
    }),
    z.object({ items: z.array(ChatSummarySchema), nextCursor: z.string().optional() }),
  ),
  /** Summaries of the named chats (e.g. restored tabs), unknown ids left out; no history is read. */
  'sessions.summaries': def(
    z.object({ sessionIds: z.array(z.string()) }),
    z.object({ items: z.array(ChatSummarySchema) }),
  ),
  'search.quick': def(
    z.object({ query: z.string(), limit: z.number() }),
    z.object({
      items: z.array(
        z.object({
          sessionId: z.string(),
          title: z.string(),
          projectName: z.string(),
          /** v1.3: the chat's project (for its icon); absent from older services. */
          projectId: z.string().optional(),
          snippet: z.string().optional(),
          score: z.number(),
          /**
           * v1.2: an archived chat. Archived matches come after every other
           * match and get up to 3 reserved slots, never more than half the
           * results (the UI groups them last); absent for the others.
           */
          archived: z.boolean().optional(),
        }),
      ),
    }),
  ),
  'chat.open': def(
    z.object({ sessionId: z.string(), tail: z.number() }),
    z.object({
      summary: ChatSummarySchema,
      header: ChatHeaderInfoSchema,
      items: z.array(ChatItemSchema),
      hasMore: z.boolean(),
      seq: z.number(),
      /** Tasks of the chat's running process (empty unless Threadgarden runs it). */
      tasks: z.array(ChatTaskSchema),
    }),
  ),
  'chat.older': def(
    z.object({ sessionId: z.string(), beforeItemId: z.string(), limit: z.number() }),
    z.object({ items: z.array(ChatItemSchema), hasMore: z.boolean() }),
  ),
  'chat.since': def(
    z.object({ sessionId: z.string(), seq: z.number() }),
    z.object({
      events: z.array(z.union([ChatItemsEventSchema, ChatStatusEventSchema, ChatTasksEventSchema])),
      seq: z.number(),
    }),
  ),
  'chat.create': def(
    z.object({
      cwd: z.string(),
      text: z.string(),
      images: z.array(ImageRefSchema).optional(),
      model: z.string().optional(),
      permissionMode: z.string().optional(),
      effort: z.string().optional(),
    }),
    z.object({ sessionId: z.string() }),
  ),
  'chat.send': def(
    z.object({
      sessionId: z.string(),
      text: z.string(),
      images: z.array(ImageRefSchema).optional(),
    }),
    z.object({ queued: z.boolean() }),
  ),
  'chat.interrupt': def(sessionIdOnly, empty),
  'chat.end': def(sessionIdOnly, empty),
  'chat.setModel': def(setValue, empty),
  'chat.setPermissionMode': def(setValue, empty),
  'chat.setEffort': def(setValue, empty),
  'chat.respond': def(
    z.object({
      sessionId: z.string(),
      requestId: z.string(),
      decision: z.enum(['allow', 'allowAlways', 'deny']),
      reason: z.string().optional(),
      suggestionIndex: z.number().optional(),
      updatedInput: z.unknown().optional(),
    }),
    empty,
  ),
  'chat.fork': def(
    z.object({ sessionId: z.string(), upToItemId: z.string() }),
    z.object({ sessionId: z.string() }),
  ),
  'chat.resumeCheck': def(
    sessionIdOnly,
    z.object({
      status: z.enum(['ok', 'blocked', 'unverified']),
      reason: z.string(),
      recentlyModified: z.boolean(),
    }),
  ),
  'chat.commands': def(
    lookupScope,
    z.array(z.object({ name: z.string(), description: z.string(), argumentHint: z.string() })),
  ),
  'chat.models': def(
    lookupScope,
    z.array(
      z.object({
        value: z.string(),
        displayName: z.string(),
        description: z.string(),
        supportedEffortLevels: z.array(z.string()).optional(),
      }),
    ),
  ),
  'chat.resumeCommand': def(sessionIdOnly, z.object({ command: z.string() })),
  /**
   * Stops one task of a chat Threadgarden runs (SDK `stopTask`); its `stopped`
   * status arrives as `chat.tasks`. Errors: `NOT_LIVE` (Threadgarden does not run the
   * chat), `UNKNOWN_TASK`, `STOP_FAILED`.
   */
  'chat.stopTask': def(z.object({ sessionId: z.string(), taskId: z.string() }), empty),
  'external.stop': def(sessionIdOnly, z.object({})),
  'files.suggest': def(
    z.object({ cwd: z.string(), query: z.string(), limit: z.number() }),
    z.array(z.object({ path: z.string(), kind: z.enum(['file', 'dir']) })),
  ),
  'meta.update': def(
    z.object({
      sessionId: z.string(),
      customTitle: z.string().nullable().optional(),
      pinned: z.boolean().optional(),
    }),
    empty,
  ),
  'drafts.get': def(z.object({ key: z.string() }), z.object({ text: z.string() })),
  'drafts.set': def(z.object({ key: z.string(), text: z.string() }), empty),
  'uiState.get': def(z.object({ key: z.string() }), z.object({ value: z.unknown() })),
  'uiState.set': def(z.object({ key: z.string(), value: z.unknown() }), empty),
  'settings.get': def(empty, SettingsSchema),
  'settings.set': def(SettingsPatchSchema, SettingsSchema),
  'auth.setApiKey': def(z.object({ key: z.string().nullable() }), empty),
  'work.stopAll': def(empty, z.object({ stopped: z.number() })),
  'service.shutdown': def(z.object({ stopAll: z.literal(true) }), empty),
  'ui.visibility': def(z.object({ visible: z.boolean() }), empty),
  'system.status': def(
    empty,
    z.object({
      claude: z.object({
        found: z.boolean(),
        path: z.string().optional(),
        version: z.string().optional(),
        problem: z.string().optional(),
      }),
      externalAvailable: z.boolean(),
      indexing: z.object({ done: z.number(), total: z.number() }),
    }),
  ),
  // ── v1.1 T2: "Your turn" ──────────────────────────────────────────────────
  /** The user has seen the chat's latest turn (idempotent); clears `unread`. */
  'chat.markSeen': def(sessionIdOnly, empty),
  // ── v1.2 B1: buckets ──────────────────────────────────────────────────────
  /**
   * Moves chats into a bucket (bulk). `holdUntil` (epoch ms) and `holdNote`
   * apply to `onHold` and replace the previous ones; other buckets clear
   * them, and every move clears `backFromHold`. Archiving also marks the
   * chats seen (Ruling R32: they leave Needs you unless they wait on the
   * user); a hold keeps them unread. Refused per chat, listed in
   * `skipped`: `NOT_FOUND` (unknown chat), `LIVE` (archiving a chat Threadgarden is
   * running — the UI asks to end it first, then retries), `RUNNING`
   * (archiving a chat that runs outside Threadgarden; it would come right back).
   */
  'chat.setBucket': def(
    z.object({
      sessionIds: z.array(z.string()),
      bucket: BucketSchema,
      holdUntil: z.number().optional(),
      holdNote: z.string().max(HOLD_NOTE_MAX).optional(),
    }),
    z.object({
      updated: z.number(),
      skipped: z.array(z.object({ sessionId: z.string(), reason: z.string() })),
    }),
  ),
  /**
   * Archives the active chats whose last activity is older than
   * `olderThanDays` days (one project, or the Active place: hidden projects
   * left out), in one transaction. Chats that run, wait on the user, are
   * pinned (Ruling R35), unread or back from hold are skipped. `dryRun` only counts them (for the
   * confirmation).
   */
  'chat.archiveOlder': def(
    z.object({
      projectId: z.string().optional(),
      olderThanDays: z.number().nonnegative(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ archived: z.number() }),
  ),
  // ── v1.3 B: usage limits and scheduled sends ───────────────────────────────
  /**
   * The account's latest known plan usage (from the sessions' rate-limit
   * events, persisted). `refresh` (the Usage view is open) also asks a running
   * chat for a fresh reading, at most once a minute and never by starting a
   * Claude process; a failed reading falls back silently.
   */
  'usage.get': def(z.object({ refresh: z.boolean().optional() }), UsageStateSchema),
  /**
   * Schedules a message (`chat.send` later): at `sendAt`, or when the usage
   * limit resets (its reset time plus `LIMIT_RESET_MARGIN_MS`; `NO_RESET_TIME`
   * when that is not known). `NOT_FOUND` for an unknown chat.
   */
  'scheduled.create': def(
    z
      .object({
        sessionId: z.string(),
        text: z.string(),
        images: z.array(ImageRefSchema).optional(),
        ...when,
      })
      .refine((p) => p.sendAt !== undefined || p.whenLimitResets === true, {
        message: 'sendAt or whenLimitResets is required',
      }),
    ScheduledSendSchema,
  ),
  /** The chat's scheduled sends (every chat's without `sessionId`), oldest due first. */
  'scheduled.list': def(
    z.object({ sessionId: z.string().optional() }),
    z.object({ items: z.array(ScheduledSendSchema) }),
  ),
  /** One scheduled send with its images (Edit). `NOT_FOUND` once it was sent or cancelled. */
  'scheduled.get': def(
    scheduledId,
    ScheduledSendSchema.extend({ images: z.array(ImageRefSchema).optional() }),
  ),
  /** Changes a scheduled send's text, images or time; a failed one becomes pending again. */
  'scheduled.update': def(
    z.object({
      id: z.string(),
      text: z.string().optional(),
      images: z.array(ImageRefSchema).optional(),
      ...when,
    }),
    ScheduledSendSchema,
  ),
  'scheduled.cancel': def(scheduledId, empty),
  /** Sends it now through `chat.send` (its errors, e.g. `RESUME_BLOCKED`, are this call's). */
  'scheduled.sendNow': def(scheduledId, empty),
  // ── v1.3 C: analytics ─────────────────────────────────────────────────────
  /**
   * Usage statistics of the range, for one project or all, aggregated in SQL
   * from Threadgarden's own per-session statistics (design §4).
   */
  'analytics.get': def(
    z.object({ range: AnalyticsRangeSchema, projectId: z.string().optional() }),
    AnalyticsSchema,
  ),
} as const;

export type MethodName = keyof typeof methods;
export type Params<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

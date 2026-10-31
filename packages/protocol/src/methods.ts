import { z } from 'zod';
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
import { ChatTaskSchema } from './tasks.js';

const empty = z.object({});
const sessionIdOnly = z.object({ sessionId: z.string() });
const setValue = z.object({ sessionId: z.string(), value: z.string() });
const lookupScope = z.object({ sessionId: z.string().optional(), cwd: z.string().optional() });

const def = <P extends z.ZodType, R extends z.ZodType>(params: P, result: R) => ({
  params,
  result,
});

export const methods = {
  hello: def(
    z.object({ protocolVersion: z.number(), client: z.string() }),
    z.object({ serviceVersion: z.string(), protocolVersion: z.number() }),
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
      /** Tasks of the chat's running process (empty unless pahub runs it). */
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
   * Stops one task of a chat pahub runs (SDK `stopTask`); its `stopped`
   * status arrives as `chat.tasks`. Errors: `NOT_LIVE` (pahub does not run the
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
   * `skipped`: `NOT_FOUND` (unknown chat), `LIVE` (archiving a chat pahub is
   * running — the UI asks to end it first, then retries), `RUNNING`
   * (archiving a chat that runs outside pahub; it would come right back).
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
} as const;

export type MethodName = keyof typeof methods;
export type Params<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

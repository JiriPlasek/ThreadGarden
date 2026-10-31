import { z } from 'zod';
import { ChatHeaderInfoSchema, ChatStatusSchema } from './chat.js';
import { ChatItemSchema } from './items.js';
import { ChatTaskSchema } from './tasks.js';
import { ScheduledSendSchema, UsageStateSchema } from './usage.js';

export const ChatItemsEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number(),
  items: z.array(ChatItemSchema),
  replace: z.boolean().optional(),
});
export type ChatItemsEvent = z.infer<typeof ChatItemsEventSchema>;

export const ChatStatusEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number(),
  status: ChatStatusSchema,
  header: ChatHeaderInfoSchema.optional(),
  waitingFor: z.string().optional(),
});
export type ChatStatusEvent = z.infer<typeof ChatStatusEventSchema>;

/**
 * The full task list of a chat Threadgarden runs (replaces the previous one). It is
 * sequenced in the same per-session log as `chat.items` / `chat.status`, so
 * `chat.since` replays it.
 */
export const ChatTasksEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number(),
  tasks: z.array(ChatTaskSchema),
});
export type ChatTasksEvent = z.infer<typeof ChatTasksEventSchema>;

export const events = {
  'chat.items': ChatItemsEventSchema,
  'chat.status': ChatStatusEventSchema,
  'chat.tasks': ChatTasksEventSchema,
  'sessions.changed': z.object({ sessionIds: z.array(z.string()) }),
  'projects.changed': z.object({}),
  'external.changed': z.object({}),
  'index.progress': z.object({ done: z.number(), total: z.number() }),
  needsYou: z.object({
    sessionId: z.string(),
    title: z.string(),
    projectName: z.string(),
    what: z.string(),
  }),
  // ── v1.1 T2: "Your turn" ──────────────────────────────────────────────────
  /** A Threadgarden chat ended a turn (once per turn); the UI decides whether to notify. */
  chatFinished: z.object({
    sessionId: z.string(),
    title: z.string(),
    projectName: z.string(),
  }),
  // ── v1.2 B1: buckets ──────────────────────────────────────────────────────
  /**
   * An on-hold chat's time ran out: it is back in Active and under Needs you
   * (`backFromHold`). Sent once, when the service notices; the UI decides
   * whether to notify.
   */
  chatBackFromHold: z.object({
    sessionId: z.string(),
    title: z.string(),
    projectName: z.string(),
  }),
  // ── v1.3 B: usage limits and scheduled sends ───────────────────────────────
  /** The account's usage state changed (a rate-limit event, a reading, a refused chat). */
  'usage.changed': UsageStateSchema,
  /** Every scheduled send (as `scheduled.list` without a chat), after any change. */
  'scheduled.changed': z.object({ items: z.array(ScheduledSendSchema) }),
  /** A scheduled message went out; `late` when it was due while the service was not running. */
  scheduledSent: z.object({
    sessionId: z.string(),
    title: z.string(),
    projectName: z.string(),
    late: z.boolean(),
    dueAt: z.number(),
  }),
} as const;

export type EventName = keyof typeof events;
export type EventData<E extends EventName> = z.infer<(typeof events)[E]>;

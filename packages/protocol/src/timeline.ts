import { z } from 'zod';

/** Bounded minute-or-coarser observations, not a reconstruction of unknown runtime states. */
export const TimelineActivitySchema = z.object({
  startedAt: z.number(),
  endedAt: z.number(),
  binMs: z.number().min(60000),
  /** Hex bitmask per bucket: 1 tool pending, 2 reasoning observed, 4 user, 8 assistant. */
  bins: z
    .string()
    .max(1440)
    .regex(/^[0-9a-f]*$/),
  prompts: z.number(),
  replies: z.number(),
  reasoning: z.number(),
  toolCalls: z.number(),
  longestTool: z.object({ name: z.string(), durationMs: z.number() }).optional(),
});
export type TimelineActivity = z.infer<typeof TimelineActivitySchema>;

/** A lightweight projection: transcript content is fetched only when a block is inspected. */
export const TimelineBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(['turn', 'agent']),
  title: z.string(),
  outcome: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']),
  startedAt: z.number().optional(),
  /** Known user-message time; absent when the turn's start was inferred. */
  promptAt: z.number().optional(),
  endedAt: z.number().optional(),
  toolCount: z.number(),
  agentCount: z.number(),
  /** Reported processed tokens; turn totals include cached input. Unknown is absent. */
  tokens: z.number().finite().nonnegative().optional(),
  model: z.string().optional(),
  activity: TimelineActivitySchema.optional(),
});
export type TimelineBlock = z.infer<typeof TimelineBlockSchema>;

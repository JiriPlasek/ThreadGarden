import { z } from 'zod';

/** A lightweight projection: transcript content is fetched only when a block is inspected. */
export const TimelineBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(['turn', 'agent']),
  title: z.string(),
  outcome: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  toolCount: z.number(),
  agentCount: z.number(),
  model: z.string().optional(),
});
export type TimelineBlock = z.infer<typeof TimelineBlockSchema>;

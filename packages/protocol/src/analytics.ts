import { z } from 'zod';

/**
 * v1.3 analytics (design §4): usage statistics the service aggregates from
 * its own per-session statistics, which the indexer extracts while it reads
 * each history through the SDK. Days are local calendar days of the machine
 * the service runs on, as `YYYY-MM-DD`.
 */
export const AnalyticsRangeSchema = z.enum(['7d', '30d', '90d', 'all']);
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

const count = z.number().int().nonnegative();

export const AnalyticsSchema = z.object({
  range: AnalyticsRangeSchema,
  projectId: z.string().optional(),
  /** First and last day of the range (inclusive). */
  from: z.string(),
  to: z.string(),
  /**
   * The series' bucket size: `day`, or `week` when "all time" spans more than
   * 120 days (each bucket then starts on a Monday; `day` names that Monday).
   */
  bucket: z.enum(['day', 'week']),
  kpis: z.object({
    /** Chats with at least one message in the range. */
    chats: count,
    /** User and assistant messages in the range (main conversation only). */
    messages: count,
    outputTokens: count,
    /** Days with at least one message. */
    activeDays: count,
    busiestProject: z
      .object({ projectId: z.string(), name: z.string(), messages: count })
      .nullable(),
  }),
  /** One entry per bucket from `from` to `to`, zeros included. */
  activity: z.array(z.object({ day: z.string(), messages: count, chatsStarted: count })),
  /**
   * Output tokens per bucket and model. `models` names the series (the four
   * busiest models, then `Other` when more exist); every `values` row lines up with it.
   */
  tokens: z.object({
    models: z.array(z.string()),
    days: z.array(
      z.object({
        day: z.string(),
        values: z.array(count),
      }),
    ),
    /** Totals per model in the range, all token kinds (for the table view). */
    totals: z.array(
      z.object({
        model: z.string(),
        input: count,
        output: count,
        cacheRead: count,
        cacheCreation: count,
      }),
    ),
  }),
  /** Busiest projects by messages, at most 10. */
  projects: z.array(
    z.object({ projectId: z.string(), name: z.string(), messages: count, chats: count }),
  ),
  /** Tool calls by tool name, at most 10. */
  tools: z.array(z.object({ name: z.string(), calls: count })),
  /** Agent (Task) tool calls by subagent type, at most 10. */
  agents: z.array(z.object({ type: z.string(), calls: count })),
  /** Messages per weekday (0 = Monday … 6 = Sunday) and hour (0–23): 7 rows of 24. */
  heatmap: z.array(z.array(count)),
  /** Most frequent meaningful words of the titles of the chats in the range (≤ 20). */
  topics: z.array(z.object({ word: z.string(), chats: count })),
  /** Indexed chats whose statistics are still being gathered (the background backfill). */
  pending: count,
});
export type Analytics = z.infer<typeof AnalyticsSchema>;

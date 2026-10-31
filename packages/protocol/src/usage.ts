import { z } from 'zod';

// ── v1.3 B: usage limits and scheduled sends ─────────────────────────────────

/**
 * One plan usage window as Threadgarden last saw it, account-wide. `key` is the SDK's
 * window name (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_oauth_apps`, `seven_day_overage_included`, `overage`,
 * `extra_usage`, or `model:<label>` for a per-model weekly window); keys this
 * UI does not know are shown by their name.
 */
export const UsageWindowSchema = z.object({
  key: z.string(),
  /** Display name the server gave a per-model window (e.g. "Fable"). */
  label: z.string().optional(),
  /** From `rate_limit_event`; absent when only the usage reading is known. Unknown values read as absent. */
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional().catch(undefined),
  /** Percentage of the window used, 0–100. */
  utilization: z.number().optional(),
  /** When the window resets (epoch ms). */
  resetsAt: z.number().optional(),
  /** When Threadgarden observed this (epoch ms). */
  observedAt: z.number(),
  /** Where it came from: a session's `rate_limit_event`, or the SDK's usage reading. */
  source: z.enum(['event', 'usage']).catch('event'),
  /** Extra usage (credits) of the account, when the usage reading reports it. */
  credits: z
    .object({
      used: z.number().optional(),
      limit: z.number().optional(),
      currency: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** A chat whose last turn a usage limit refused, until a later turn goes through. */
export const RefusedChatSchema = z.object({
  sessionId: z.string(),
  /** When the refusal was seen (epoch ms). */
  at: z.number(),
  /** When the limit resets, when known (epoch ms). */
  resetsAt: z.number().optional(),
});
export type RefusedChat = z.infer<typeof RefusedChatSchema>;

export const UsageStateSchema = z.object({
  windows: z.array(UsageWindowSchema).default([]),
  /** claude.ai plan (`pro`, `max`, …) when the usage reading reported one. */
  subscriptionType: z.string().optional(),
  /** False: plan limits do not apply (API key, Bedrock, Vertex). Absent: not known. */
  rateLimitsAvailable: z.boolean().optional(),
  refused: z.array(RefusedChatSchema).default([]),
});
export type UsageState = z.infer<typeof UsageStateSchema>;

export const usageEmpty: UsageState = UsageStateSchema.parse({});

/** Margin after a limit reset before a send "when the limit resets" goes out. */
export const LIMIT_RESET_MARGIN_MS = 30_000;

/**
 * A message the service sends to a chat later. Lists never carry the image
 * data (`scheduled.get` does), only how many images there are.
 */
export const ScheduledSendSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  text: z.string(),
  imageCount: z.number().int().nonnegative(),
  /** When it goes out (epoch ms). */
  sendAt: z.number(),
  createdAt: z.number(),
  /**
   * `pending` waits for its time; `sending` went out and its turn has not
   * ended yet; `failed` could not be sent (or the limit refused it again) and
   * waits for the user (Send now or Cancel).
   */
  state: z.enum(['pending', 'sending', 'failed']),
  /** Scheduled for when the usage limit resets. */
  afterLimitReset: z.boolean(),
  /** Already moved once to a later reset because the limit still refused it. */
  rescheduled: z.boolean(),
  /** Why it failed. */
  error: z.string().optional(),
  /** It was due while the service was not running. */
  late: z.boolean().optional(),
});
export type ScheduledSend = z.infer<typeof ScheduledSendSchema>;

import { z } from 'zod';
import { UsageAccountSchema } from './usage.js';

/** Advertised in `hello` by a service that can sign in to Claude (protocol 14); added at runtime. */
export const CLAUDE_LOGIN_CAPABILITY = 'claude-login';

export const CLAUDE_LOGIN_ERRORS = {
  /** Claude Code refused or failed; the message is in its words. */
  failed: 'LOGIN_FAILED',
  /** A code arrived without a sign-in in progress. */
  notStarted: 'LOGIN_NOT_STARTED',
  /** The machine uses an API key or a provider, which has no Claude sign-in. */
  unsupported: 'LOGIN_UNSUPPORTED',
} as const;

export const ClaudeAccountSchema = z.object({
  /** Null: not known yet. */
  account: UsageAccountSchema.nullable(),
  /** The sign-in has expired. */
  expired: z.boolean(),
  /** A sign-in is in progress. */
  signingIn: z.boolean(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

import { z } from 'zod';

/** Advertised in `hello` by a service whose PTY module loaded (protocol 13); added at runtime. */
export const SHELL_CAPABILITY = 'shell';

export const SHELL_ERRORS = {
  /** A Codex chat, or a chat without a session, has no `!` commands. */
  unsupported: 'SHELL_UNSUPPORTED',
  /** The chat already has a command running. */
  busy: 'SHELL_BUSY',
  /** The run is over or unknown. */
  notRunning: 'SHELL_NOT_RUNNING',
  /** The command couldn't be started. */
  failed: 'SHELL_FAILED',
} as const;

/** Longest command, in characters. */
export const SHELL_COMMAND_MAX = 16_384;
/** Most characters one `shell.input` may carry. */
export const SHELL_INPUT_MAX = 65_536;
/** How much output the service keeps for a command, in characters. */
export const SHELL_SCROLLBACK_CHARS = 262_144;
export const SHELL_DEFAULT_SIZE = { cols: 100, rows: 24 } as const;

export const ShellSizeSchema = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
});
export type ShellSize = z.infer<typeof ShellSizeSchema>;

export const ShellRunSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  command: z.string(),
  cwd: z.string(),
  cols: ShellSizeSchema.shape.cols,
  rows: ShellSizeSchema.shape.rows,
  startedAt: z.number(),
  state: z.enum(['running', 'stopping', 'ended']),
  endedAt: z.number().optional(),
  exitCode: z.number().int().nullable().optional(),
  /** `session`: ended with the session, so not appended to the chat. */
  endReason: z.enum(['exit', 'stopped', 'session']).optional(),
  /** The item id of the appended `! command` line, set once it's appended. */
  entryId: z.string().optional(),
  /** The item id of the appended output entry, set once it's appended. */
  outputId: z.string().optional(),
});
export type ShellRun = z.infer<typeof ShellRunSchema>;

export const ShellViewSchema = z.object({
  run: ShellRunSchema,
  /** The scrollback. */
  output: z.string(),
  /** How many emitted characters came before `output`. */
  offset: z.number().int().nonnegative(),
});
export type ShellView = z.infer<typeof ShellViewSchema>;

import { z } from 'zod';

/** Advertised in `hello` by a service that serves `mcp.*` and `chat.wake` (protocol 12). */
export const MCP_CAPABILITY = 'mcp';

export const MCP_ERRORS = {
  /** A Codex chat has no MCP servers to manage. */
  unsupported: 'MCP_UNSUPPORTED',
  /** Claude Code refused; the message is its own words. */
  failed: 'MCP_FAILED',
  /** The settings file of the project can't be read, so a server can't be approved. */
  settingsUnreadable: 'SETTINGS_UNREADABLE',
} as const;

export const McpStatusSchema = z.enum([
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
  'unapproved',
]);
export type McpStatus = z.infer<typeof McpStatusSchema>;

export const McpServerSchema = z.object({
  name: z.string(),
  /** The SDK's `source ?? scope ?? ''`. */
  source: z.string(),
  status: McpStatusSchema,
  error: z.string().optional(),
  claudeAi: z.boolean(),
  /** True for http/sse servers that aren't claude.ai connectors. */
  canSignIn: z.boolean(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpStateSchema = z.object({
  sessionId: z.string(),
  live: z.boolean(),
  servers: z.array(McpServerSchema),
  /** The banner's names (the `unapproved` servers), in `.mcp.json` order. */
  waiting: z.array(z.string()),
});
export type McpState = z.infer<typeof McpStateSchema>;

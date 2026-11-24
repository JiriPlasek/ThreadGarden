import { z } from 'zod';

/** Advertised in `hello` by a service that serves `mcp.*` and `chat.wake` (protocol 12). */
export const MCP_CAPABILITY = 'mcp';

/** Advertised in `hello` by a service that can add and remove MCP servers (`mcp.add`, `mcp.remove`). */
export const MCP_CONFIG_CAPABILITY = 'mcp-config';

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

/** Where Claude Code keeps a server: this project for me, every project for me, or `.mcp.json`. */
export const McpScopeSchema = z.enum(['local', 'user', 'project']);
export type McpScope = z.infer<typeof McpScopeSchema>;

/** Letters, digits, `-` and `_` (Claude Code's rule); never a leading `-`, since the name is an argument. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string().min(1), z.string()).optional(),
  }),
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

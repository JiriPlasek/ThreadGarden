import type { McpServer, McpState, McpStatus } from '@threadgarden/protocol';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus } from '../sdk/adapter';

export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/**
 * Only `system/init` (it carries `mcp_servers`). The spike observed no MCP
 * status messages in an SDK session; see
 * docs/superpowers/specs/2026-11-22-mcp-servers-spike-results.md (MCP_STATUS_MESSAGES).
 */
export const isMcpStatusMessage = (m: SDKMessage): boolean =>
  m.type === 'system' && (m as { subtype?: string }).subtype === 'init';

/** The sign-in link from `mcpAuthenticate`'s result, or null when it carries none. */
export const signInUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const url = (raw as { authUrl?: unknown }).authUrl;
  return typeof url === 'string' && url !== '' ? url : null;
};

const ORDER: McpStatus[] = [
  'unapproved',
  'needs-auth',
  'failed',
  'pending',
  'connected',
  'disabled',
];

const byName = (a: McpServer, b: McpServer): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const fromStatus = (s: McpServerStatus): McpServer => {
  const source = s.source ?? s.scope ?? '';
  const type = (s.config as { type?: string } | undefined)?.type;
  const claudeAi = source === 'claudeai' || s.scope === 'claudeai' || type === 'claudeai-proxy';
  return {
    name: s.name,
    source,
    status: s.status,
    ...(s.error !== undefined ? { error: s.error } : {}),
    claudeAi,
    canSignIn: (type === 'http' || type === 'sse') && !claudeAi,
  };
};

/**
 * A project server is unapproved when `.mcp.json` names it and Claude Code
 * doesn't list it (an SDK session lists never-approved ones like any other;
 * only one rejected earlier is absent).
 */
export const buildMcpState = (
  sessionId: string,
  statuses: McpServerStatus[],
  project: { names: string[] },
): McpState => {
  const listed = new Set(statuses.map((s) => s.name));
  const waiting = project.names.filter((n) => !listed.has(n));
  const unapproved: McpServer[] = waiting.map((name) => ({
    name,
    source: 'project',
    status: 'unapproved',
    claudeAi: false,
    canSignIn: false,
  }));
  const rest = statuses
    .map(fromStatus)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || byName(a, b));
  return { sessionId, live: true, servers: [...unapproved, ...rest], waiting };
};

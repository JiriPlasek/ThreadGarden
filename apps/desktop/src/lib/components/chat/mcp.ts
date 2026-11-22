import type { McpServer } from '@threadgarden/protocol';

/**
 * Where a claude.ai connector is signed in. The same address as the service's
 * `CLAUDE_AI_CONNECTORS_URL` (packages/service/src/mcp/state.ts), which the
 * desktop can't import.
 */
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/** Claude Code saves the toggle per project, so the label says so. */
export const TURN_OFF_LABEL = 'Turn off in this project';

export const clearAuthLabel = (machine: string): string => `Forget sign-in on ${machine}`;

export const statusLabel = (s: McpServer): string => {
  switch (s.status) {
    case 'connected':
      return 'Connected';
    case 'pending':
      return 'Connecting…';
    case 'needs-auth':
      return 'Needs sign-in';
    case 'failed':
      return s.error ? `Failed: ${s.error}` : 'Failed';
    case 'disabled':
      return 'Off';
    case 'unapproved':
      return 'Not approved';
  }
};

export const sourceLabel = (source: string): string => {
  if (source === 'claudeai') return 'claude.ai';
  if (source === 'managed' || source === 'enterprise') return 'managed';
  return source;
};

export type PrimaryAction = 'approve' | 'signIn' | 'claudeAiSignIn' | 'reconnect' | 'turnOn';
export type MenuAction = 'reconnect' | 'turnOff' | 'clearAuth';

export const primaryAction = (s: McpServer): PrimaryAction | null => {
  switch (s.status) {
    case 'unapproved':
      return 'approve';
    case 'needs-auth':
      return s.claudeAi ? 'claudeAiSignIn' : 'signIn';
    case 'failed':
      return 'reconnect';
    case 'disabled':
      return 'turnOn';
    default:
      return null;
  }
};

export const menuActions = (s: McpServer): MenuAction[] => {
  switch (s.status) {
    case 'needs-auth':
      return ['reconnect', 'turnOff'];
    case 'failed':
      return s.canSignIn ? ['turnOff', 'clearAuth'] : ['turnOff'];
    case 'connected':
      return s.canSignIn ? ['reconnect', 'turnOff', 'clearAuth'] : ['reconnect', 'turnOff'];
    case 'pending':
      return ['turnOff'];
    default:
      return [];
  }
};

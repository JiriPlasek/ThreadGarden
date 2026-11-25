import {
  MCP_LIMITS,
  MCP_SERVER_NAME,
  type McpScope,
  type McpServer,
  type McpServerConfig,
} from '@threadgarden/protocol';

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
export type MenuAction = 'reconnect' | 'turnOff' | 'clearAuth' | 'remove';

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

export type AddForm = {
  name: string;
  type: 'http' | 'stdio';
  url: string;
  command: string;
  /** One argument per line. */
  args: string;
  /** Kept apart, so switching the type carries nothing across. */
  headers: { key: string; value: string }[];
  env: { key: string; value: string }[];
  scope: McpScope;
};

export const emptyAddForm = (): AddForm => ({
  name: '',
  type: 'http',
  url: '',
  command: '',
  args: '',
  headers: [],
  env: [],
  scope: 'local',
});

export const SCOPE_LABELS: Record<McpScope, string> = {
  local: 'Me, this project',
  user: 'Me, every project',
  project: 'Everyone (.mcp.json)',
};

export const PROJECT_SCOPE_NOTE =
  "Saved in this project's .mcp.json, which is usually committed and shared with everyone who clones the project.";

export const ADDED_AFTER_RESTART = 'Added. It appears when this chat restarts between turns.';
export const REMOVED_AFTER_RESTART =
  'Removed. It disappears when this chat restarts between turns.';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The rows of the current type; a blank key with a blank value is an unused row. */
const usedPairs = (f: AddForm) =>
  (f.type === 'http' ? f.headers : f.env)
    .filter((p) => p.key.trim() !== '' || p.value !== '')
    .map((p) => ({ key: p.key.trim(), value: p.value }));

const argList = (args: string): string[] =>
  args
    .split(/\n/)
    .map((a) => a.replace(/\r$/, ''))
    .filter((a) => a !== '');

const tooLong = (field: string, max: number): string =>
  `That's too long: ${field} can be at most ${max} characters.`;

/** The first problem with the form, or null. */
export const validateAddForm = (f: AddForm): string | null => {
  const name = f.name.trim();
  if (!MCP_SERVER_NAME.test(name))
    return 'Use letters, numbers, - and _ for the name (not starting with -).';
  const http = f.type === 'http';
  if (http) {
    if (!/^https?:\/\/\S+$/i.test(f.url.trim()) || !URL.canParse(f.url.trim()))
      return 'Enter a full address starting with https:// or http://.';
  } else if (f.command.trim() === '') return 'Enter the command to run.';
  const pairs = usedPairs(f);
  for (const p of pairs) {
    if (http && p.key === '') return 'Give every header a name.';
    if (!http && !ENV_NAME.test(p.key))
      return 'Environment names use letters, numbers and _, not starting with a number.';
  }
  if (name.length > MCP_LIMITS.name) return tooLong('Name', MCP_LIMITS.name);
  if (http && f.url.trim().length > MCP_LIMITS.url) return tooLong('URL', MCP_LIMITS.url);
  if (!http) {
    if (f.command.trim().length > MCP_LIMITS.command) return tooLong('Command', MCP_LIMITS.command);
    const args = argList(f.args);
    if (args.length > MCP_LIMITS.args)
      return `That's too many: at most ${MCP_LIMITS.args} arguments.`;
    if (args.some((a) => a.length > MCP_LIMITS.arg)) return tooLong('an argument', MCP_LIMITS.arg);
  }
  const noun = http ? 'header' : 'variable';
  if (pairs.length > MCP_LIMITS.entries)
    return `That's too many: at most ${MCP_LIMITS.entries} ${noun}s.`;
  for (const p of pairs) {
    if (p.key.length > MCP_LIMITS.key) return tooLong(`a ${noun} name`, MCP_LIMITS.key);
    if (p.value.length > MCP_LIMITS.value) return tooLong(`a ${noun} value`, MCP_LIMITS.value);
  }
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.key)) return `${p.key} appears twice.`;
    seen.add(p.key);
  }
  return null;
};

/** The JSON `claude mcp add-json` takes; empty headers, env and args are left out. */
export const toServerConfig = (f: AddForm): McpServerConfig => {
  const pairs = usedPairs(f);
  const map = Object.fromEntries(pairs.map((p) => [p.key, p.value]));
  if (f.type === 'http') {
    return { type: 'http', url: f.url.trim(), ...(pairs.length > 0 ? { headers: map } : {}) };
  }
  const args = argList(f.args);
  return {
    type: 'stdio',
    command: f.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(pairs.length > 0 ? { env: map } : {}),
  };
};

/** The scope a server can be removed from; null for connectors, plugins and the like. */
export const removeScope = (s: McpServer): McpScope | null =>
  s.source === 'local' || s.source === 'user' || s.source === 'project' ? s.source : null;

export const removeText = (machine: string, scope: McpScope): string =>
  `Claude Code on ${machine} stops using it for ${SCOPE_LABELS[scope]}.`;

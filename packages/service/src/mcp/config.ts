import { spawn } from 'node:child_process';
import type { McpScope, McpServerConfig } from '@threadgarden/protocol';
import { claudeInvocation } from '../sdk/claude-path';
import { ServiceError } from '../server/router';

export const MCP_CONFIG_TIMEOUT_MS = 30_000;

/** From the spike (2026-11-24-mcp-add-server-spike-results.md). */
export const CONFIG_SEEN_BY: {
  add: 'status' | 'reconnect' | 'restart';
  remove: 'status' | 'reconnect' | 'restart';
} = { add: 'reconnect', remove: 'restart' };

export interface McpConfig {
  add(o: { cwd: string; scope: McpScope; name: string; config: McpServerConfig }): Promise<void>;
  remove(o: { cwd: string; scope: McpScope; name: string }): Promise<void>;
}

/** The JSON goes on stdin (`-`); `--` keeps a name from being read as an option. */
export const addJsonArgs = (name: string, scope: McpScope): string[] => [
  'mcp',
  'add-json',
  '--scope',
  scope,
  '--',
  name,
  '-',
];
export const removeArgs = (name: string, scope: McpScope): string[] => [
  'mcp',
  'remove',
  '--scope',
  scope,
  '--',
  name,
];

/** Replaces every non-empty header / environment value in `text` with `•••`. */
export const maskValues = (text: string, config: McpServerConfig): string => {
  const values = Object.values(config.type === 'http' ? (config.headers ?? {}) : (config.env ?? {}))
    .filter((v) => v !== '')
    // Longest first, so a value that contains another is hidden whole.
    .sort((a, b) => b.length - a.length);
  return values.reduce((t, v) => t.split(v).join('•••'), text);
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const clean = (s: string): string => s.replace(ANSI, '').trim();

/**
 * The CLI must not think it runs inside a Claude Code session (it refuses stdin there).
 * CLAUDE_CODE_GIT_BASH_PATH stays: on Windows the CLI needs it to find Git Bash.
 */
const childEnv = (env: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_GIT_BASH_PATH'))
      continue;
    out[k] = v;
  }
  return out;
};

export type ClaudeCliDeps = {
  claude: () => Promise<{ path: string } | { detail: string }>;
  env: () => Record<string, string | undefined>;
  timeoutMs?: number;
};

/**
 * Runs the `claude` CLI with `args` (resolved path, env without CLAUDECODE and
 * CLAUDE_CODE_*, no shell, a timeout): resolves on exit 0, else rejects with
 * the CLI's own words.
 */
export const claudeCliRunner =
  (deps: ClaudeCliDeps) =>
  async (cwd: string, args: string[], stdin?: string): Promise<void> => {
    const found = await deps.claude();
    if (!('path' in found)) throw new ServiceError('CLAUDE_MISSING', found.detail);
    const { cmd, argv } = claudeInvocation(found.path, args);
    const timeoutMs = deps.timeoutMs ?? MCP_CONFIG_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, argv, {
        cwd,
        env: childEnv(deps.env()),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error("Claude Code didn't answer in 30 s.")));
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      child.on('error', (e) => finish(() => reject(e)));
      child.on('close', (code) =>
        finish(() => {
          if (code === 0) return resolve();
          reject(
            new Error(clean(err) || clean(out) || `claude ${args[0] ?? ''} exited with ${code}`),
          );
        }),
      );
      // A child that exits before reading stdin must not crash the service.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    });
  };

export const cliMcpConfig = (deps: ClaudeCliDeps): McpConfig => {
  const run = claudeCliRunner(deps);
  return {
    add: ({ cwd, scope, name, config }) =>
      run(cwd, addJsonArgs(name, scope), JSON.stringify(config)),
    remove: ({ cwd, scope, name }) => run(cwd, removeArgs(name, scope)),
  };
};

import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  MCP_CAPABILITY,
  MCP_CONFIG_CAPABILITY,
  MCP_ERRORS,
  McpServerSchema,
  McpStateSchema,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  events,
  methods,
} from '../src/index.js';

describe('protocol 12', () => {
  it('PROTOCOL_VERSION is 13 and the remote range is 12..14', () => {
    expect(PROTOCOL_VERSION).toBe(13);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 12, max: 14 });
  });

  it("MCP_CAPABILITY is 'mcp' and not in CAPABILITIES", () => {
    expect(MCP_CAPABILITY).toBe('mcp');
    expect(CAPABILITIES).not.toContain('mcp');
  });

  it('McpServerSchema parses every status and refuses an unknown one', () => {
    for (const status of [
      'connected',
      'pending',
      'needs-auth',
      'failed',
      'disabled',
      'unapproved',
    ]) {
      const server = { name: 'a', source: 'project', status, claudeAi: false, canSignIn: true };
      expect(McpServerSchema.safeParse(server).success, status).toBe(true);
    }
    const bad = { name: 'a', source: '', status: 'broken', claudeAi: false, canSignIn: false };
    expect(McpServerSchema.safeParse(bad).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...bad, status: 'failed', error: 'boom' }).success).toBe(
      true,
    );
    expect(
      McpStateSchema.safeParse({ sessionId: 's', live: true, servers: [], waiting: ['a'] }).success,
    ).toBe(true);
  });

  it('mcp.* methods, chat.wake and mcp.changed are listed', () => {
    for (const m of [
      'mcp.list',
      'mcp.approve',
      'mcp.signIn',
      'mcp.submitCallback',
      'mcp.act',
      'chat.wake',
    ]) {
      expect(Object.keys(methods), m).toContain(m);
      expect((methods as Record<string, { localOnly?: boolean }>)[m]?.localOnly, m).toBeFalsy();
    }
    expect(Object.keys(events)).toContain('mcp.changed');
    expect(methods['mcp.signIn'].result.parse({ url: null })).toEqual({ url: null });
    expect(
      methods['mcp.act'].params.safeParse({ sessionId: 's', name: 'n', action: 'clearAuth' })
        .success,
    ).toBe(true);
    expect(
      methods['mcp.act'].params.safeParse({ sessionId: 's', name: 'n', action: 'restart' }).success,
    ).toBe(false);
    expect(Object.values(MCP_ERRORS)).toEqual([
      'MCP_UNSUPPORTED',
      'MCP_FAILED',
      'SETTINGS_UNREADABLE',
    ]);
  });

  it("mcp.submitCallback refuses a url that isn't a URL", () => {
    const p = methods['mcp.submitCallback'].params;
    expect(p.safeParse({ sessionId: 's', name: 'n', url: 'nope' }).success).toBe(false);
    expect(
      p.safeParse({ sessionId: 's', name: 'n', url: 'http://localhost:1/cb?code=x' }).success,
    ).toBe(true);
  });
});

describe('mcp.add and mcp.remove', () => {
  const add = methods['mcp.add'].params;
  const base = { sessionId: 's1', name: 'sentry', scope: 'local' };
  const http = { type: 'http', url: 'https://mcp.sentry.dev/mcp' };

  it("MCP_CONFIG_CAPABILITY is 'mcp-config' and not in CAPABILITIES", () => {
    expect(MCP_CONFIG_CAPABILITY).toBe('mcp-config');
    expect(CAPABILITIES).not.toContain('mcp-config');
  });

  it('are listed and not localOnly', () => {
    for (const name of ['mcp.add', 'mcp.remove'] as const) {
      expect(methods[name]).toBeDefined();
      expect((methods[name] as { localOnly?: boolean }).localOnly).toBeFalsy();
    }
  });

  it('mcp.add takes an http and a stdio server', () => {
    const headers = { Authorization: 'Bearer x' };
    expect(add.safeParse({ ...base, config: { ...http, headers } }).success).toBe(true);
    const stdio = { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } };
    expect(add.safeParse({ ...base, scope: 'user', config: stdio }).success).toBe(true);
    expect(methods['mcp.add'].result.safeParse({ restartPending: false }).success).toBe(true);
    expect(
      methods['mcp.remove'].params.safeParse({ sessionId: 's1', name: 'sentry', scope: 'project' })
        .success,
    ).toBe(true);
  });

  it('mcp.add refuses a bad name, URL, scope or command', () => {
    for (const name of ['', '-x', 'a b']) {
      expect(add.safeParse({ ...base, name, config: http }).success).toBe(false);
    }
    expect(add.safeParse({ ...base, config: { type: 'http', url: 'nope' } }).success).toBe(false);
    expect(add.safeParse({ ...base, scope: 'global', config: http }).success).toBe(false);
    expect(add.safeParse({ ...base, config: { type: 'stdio', command: '' } }).success).toBe(false);
  });

  it('mcp.add takes http(s) URLs only', () => {
    for (const url of ['file:///x', 'ftp://h', 'javascript:alert(1)']) {
      expect(add.safeParse({ ...base, config: { type: 'http', url } }).success).toBe(false);
    }
    for (const url of ['https://mcp.sentry.dev/mcp', 'http://localhost:3000/mcp']) {
      expect(add.safeParse({ ...base, config: { type: 'http', url } }).success).toBe(true);
    }
  });

  it('mcp.add refuses over-limit input', () => {
    expect(add.safeParse({ ...base, name: 'a'.repeat(101), config: http }).success).toBe(false);
    const args = Array.from({ length: 101 }, () => 'x');
    expect(add.safeParse({ ...base, config: { type: 'stdio', command: 'c', args } }).success).toBe(false);
    const env = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'v']));
    expect(add.safeParse({ ...base, config: { type: 'stdio', command: 'c', env } }).success).toBe(false);
  });
});

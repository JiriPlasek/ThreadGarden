import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  MCP_CAPABILITY,
  MCP_ERRORS,
  McpServerSchema,
  McpStateSchema,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  events,
  methods,
} from '../src/index.js';

describe('protocol 12', () => {
  it('PROTOCOL_VERSION is 12 and the remote range is 11..13', () => {
    expect(PROTOCOL_VERSION).toBe(12);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 11, max: 13 });
  });

  it("MCP_CAPABILITY is 'mcp' and not in CAPABILITIES", () => {
    expect(MCP_CAPABILITY).toBe('mcp');
    expect(CAPABILITIES).not.toContain('mcp');
  });

  it('McpServerSchema parses every status and refuses an unknown one', () => {
    for (const status of ['connected', 'pending', 'needs-auth', 'failed', 'disabled', 'unapproved']) {
      const server = { name: 'a', source: 'project', status, claudeAi: false, canSignIn: true };
      expect(McpServerSchema.safeParse(server).success, status).toBe(true);
    }
    const bad = { name: 'a', source: '', status: 'broken', claudeAi: false, canSignIn: false };
    expect(McpServerSchema.safeParse(bad).success).toBe(false);
    expect(
      McpServerSchema.safeParse({ ...bad, status: 'failed', error: 'boom' }).success,
    ).toBe(true);
    expect(
      McpStateSchema.safeParse({ sessionId: 's', live: true, servers: [], waiting: ['a'] }).success,
    ).toBe(true);
  });

  it('mcp.* methods, chat.wake and mcp.changed are listed', () => {
    for (const m of ['mcp.list', 'mcp.approve', 'mcp.signIn', 'mcp.submitCallback', 'mcp.act', 'chat.wake']) {
      expect(Object.keys(methods), m).toContain(m);
      expect((methods as Record<string, { localOnly?: boolean }>)[m]?.localOnly, m).toBeFalsy();
    }
    expect(Object.keys(events)).toContain('mcp.changed');
    expect(methods['mcp.signIn'].result.parse({ url: null })).toEqual({ url: null });
    expect(methods['mcp.act'].params.safeParse({ sessionId: 's', name: 'n', action: 'clearAuth' }).success).toBe(true);
    expect(methods['mcp.act'].params.safeParse({ sessionId: 's', name: 'n', action: 'restart' }).success).toBe(false);
    expect(Object.values(MCP_ERRORS)).toEqual(['MCP_UNSUPPORTED', 'MCP_FAILED', 'SETTINGS_UNREADABLE']);
  });

  it("mcp.submitCallback refuses a url that isn't a URL", () => {
    const p = methods['mcp.submitCallback'].params;
    expect(p.safeParse({ sessionId: 's', name: 'n', url: 'nope' }).success).toBe(false);
    expect(p.safeParse({ sessionId: 's', name: 'n', url: 'http://localhost:1/cb?code=x' }).success).toBe(true);
  });
});

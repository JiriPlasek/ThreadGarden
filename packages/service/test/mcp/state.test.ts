import { describe, expect, it } from 'vitest';
import { buildMcpState, signInUrl } from '../../src/mcp/state';
import type { McpServerStatus } from '../../src/sdk/adapter';

const st = (o: Record<string, unknown> & { name: string }): McpServerStatus =>
  ({ status: 'connected', source: 'project', scope: 'project', ...o }) as McpServerStatus;
const build = (statuses: McpServerStatus[], names: string[] = []) =>
  buildMcpState('s1', statuses, { names });

describe('buildMcpState', () => {
  it('a .mcp.json server missing from the status list is unapproved and waiting', () => {
    const s = build([], ['etoro']);
    expect(s.live).toBe(true);
    expect(s.sessionId).toBe('s1');
    expect(s.waiting).toEqual(['etoro']);
    expect(s.servers).toEqual([
      { name: 'etoro', source: 'project', status: 'unapproved', claudeAi: false, canSignIn: false },
    ]);
  });
  it("a project server in the status list keeps its status and isn't waiting", () => {
    const s = build([st({ name: 'etoro', status: 'needs-auth' })], ['etoro']);
    expect(s.waiting).toEqual([]);
    expect(s.servers[0]).toMatchObject({ name: 'etoro', status: 'needs-auth', source: 'project' });
  });
  it('a turned-off project server is Off, not waiting', () => {
    const s = build([st({ name: 'etoro', status: 'disabled' })], ['etoro']);
    expect(s.waiting).toEqual([]);
    expect(s.servers[0]?.status).toBe('disabled');
  });
  it("claude.ai connectors can't sign in here; http servers can; stdio servers can't", () => {
    const s = build([
      st({
        name: 'gmail',
        source: 'claudeai',
        scope: 'claudeai',
        config: { type: 'claudeai-proxy', url: 'u', id: 'i' },
      }),
      st({ name: 'linear', config: { type: 'http', url: 'u' } }),
      st({ name: 'sse1', config: { type: 'sse', url: 'u' } }),
      st({ name: 'echo', config: { type: 'stdio', command: 'x' } }),
    ]);
    const by = Object.fromEntries(s.servers.map((x) => [x.name, x]));
    expect(by.gmail).toMatchObject({ claudeAi: true, canSignIn: false });
    expect(by.linear).toMatchObject({ claudeAi: false, canSignIn: true });
    expect(by.sse1).toMatchObject({ claudeAi: false, canSignIn: true });
    expect(by.echo).toMatchObject({ claudeAi: false, canSignIn: false });
  });
  it("failed keeps Claude Code's error", () => {
    const s = build([st({ name: 'x', status: 'failed', error: 'spawn ENOENT' })]);
    expect(s.servers[0]).toMatchObject({ status: 'failed', error: 'spawn ENOENT' });
  });
  it('orders unapproved, needs sign-in, failed, connecting, connected, off', () => {
    const s = build(
      [
        st({ name: 'off', status: 'disabled' }),
        st({ name: 'b-ok', status: 'connected' }),
        st({ name: 'a-ok', status: 'connected' }),
        st({ name: 'wait', status: 'pending' }),
        st({ name: 'bad', status: 'failed' }),
        st({ name: 'auth', status: 'needs-auth' }),
      ],
      ['z2', 'z1'],
    );
    expect(s.servers.map((x) => x.name)).toEqual([
      'z2',
      'z1',
      'auth',
      'bad',
      'wait',
      'a-ok',
      'b-ok',
      'off',
    ]);
    expect(s.waiting).toEqual(['z2', 'z1']);
  });
});

describe('signInUrl', () => {
  it('reads the link', () => {
    expect(
      signInUrl({
        authUrl: 'https://x/authorize?a=1',
        requiresUserAction: true,
        callbackExpected: true,
        redirectScheme: 'localhost',
        state: 's',
        callbackPort: 1234,
      }),
    ).toBe('https://x/authorize?a=1');
    expect(signInUrl({ requiresUserAction: false })).toBeNull();
    expect(signInUrl(undefined)).toBeNull();
    expect(signInUrl({})).toBeNull();
  });
});

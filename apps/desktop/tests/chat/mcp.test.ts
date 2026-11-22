import type { McpServer, McpState } from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthLabel,
  menuActions,
  primaryAction,
  sourceLabel,
  statusLabel,
  TURN_OFF_LABEL,
} from '../../src/lib/components/chat/mcp';
import type { Api } from '../../src/lib/state/api';
import { ChatMcp, MCP_POLL_MS } from '../../src/lib/state/mcp.svelte';

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: 'github',
  source: 'project',
  status: 'connected',
  claudeAi: false,
  canSignIn: false,
  ...over,
});

describe('labels', () => {
  it('statusLabel covers every status', () => {
    expect(statusLabel(server({ status: 'connected' }))).toBe('Connected');
    expect(statusLabel(server({ status: 'pending' }))).toBe('Connecting…');
    expect(statusLabel(server({ status: 'needs-auth' }))).toBe('Needs sign-in');
    expect(statusLabel(server({ status: 'failed', error: 'spawn ENOENT' }))).toBe(
      'Failed: spawn ENOENT',
    );
    expect(statusLabel(server({ status: 'failed' }))).toBe('Failed');
    expect(statusLabel(server({ status: 'disabled' }))).toBe('Off');
    expect(statusLabel(server({ status: 'unapproved' }))).toBe('Not approved');
  });

  it('sourceLabel', () => {
    expect(sourceLabel('claudeai')).toBe('claude.ai');
    expect(sourceLabel('managed')).toBe('managed');
    expect(sourceLabel('enterprise')).toBe('managed');
    for (const s of ['project', 'user', 'local', 'plugin', 'weird']) expect(sourceLabel(s)).toBe(s);
  });

  it('the fixed copy', () => {
    expect(TURN_OFF_LABEL).toBe('Turn off in this project');
    expect(clearAuthLabel('Ubuntu PC')).toBe('Forget sign-in on Ubuntu PC');
  });
});

describe('the action table', () => {
  const row = (s: Partial<McpServer>) => [primaryAction(server(s)), menuActions(server(s))];

  it('unapproved', () => expect(row({ status: 'unapproved' })).toEqual(['approve', []]));
  it('needs-auth', () => {
    expect(row({ status: 'needs-auth' })).toEqual(['signIn', ['reconnect', 'turnOff']]);
    expect(row({ status: 'needs-auth', claudeAi: true })).toEqual([
      'claudeAiSignIn',
      ['reconnect', 'turnOff'],
    ]);
  });
  it('failed', () => {
    expect(row({ status: 'failed' })).toEqual(['reconnect', ['turnOff']]);
    expect(row({ status: 'failed', canSignIn: true })).toEqual([
      'reconnect',
      ['turnOff', 'clearAuth'],
    ]);
  });
  it('connected', () => {
    expect(row({ status: 'connected' })).toEqual([null, ['reconnect', 'turnOff']]);
    expect(row({ status: 'connected', canSignIn: true })).toEqual([
      null,
      ['reconnect', 'turnOff', 'clearAuth'],
    ]);
  });
  it('pending', () => expect(row({ status: 'pending' })).toEqual([null, ['turnOff']]));
  it('disabled', () => expect(row({ status: 'disabled' })).toEqual(['turnOn', []]));
});

const stateOf = (sessionId: string, servers: McpServer[] = []): McpState => ({
  sessionId,
  live: true,
  servers,
  waiting: [],
});

const fakeApi = () => {
  const listeners = new Set<(e: McpState) => void>();
  const request = vi.fn(async (method: string, params: { sessionId: string }) => {
    if (method === 'mcp.list') return stateOf(params.sessionId, [server()]);
    return {};
  });
  const api = {
    status: 'open',
    request,
    on: (event: string, cb: (e: McpState) => void) => {
      if (event === 'mcp.changed') listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onOpen: () => () => {},
    onReconnect: () => () => {},
    onStatus: () => () => {},
  };
  return {
    api: api as unknown as Api,
    request,
    emit: (e: McpState) => listeners.forEach((cb) => cb(e)),
    lists: () => request.mock.calls.filter((c) => c[0] === 'mcp.list').length,
  };
};

describe('ChatMcp', () => {
  afterEach(() => vi.useRealTimers());

  it('polls while open and stops after', async () => {
    vi.useFakeTimers();
    const f = fakeApi();
    const mcp = new ChatMcp(f.api, 's1');
    const stop = mcp.startPolling();
    await vi.advanceTimersByTimeAsync(MCP_POLL_MS * 2);
    expect(f.lists()).toBe(2);
    expect(mcp.state?.servers).toHaveLength(1);
    stop();
    await vi.advanceTimersByTimeAsync(MCP_POLL_MS * 3);
    expect(f.lists()).toBe(2);
    mcp.stop();
  });

  it('ignores mcp.changed of other chats', () => {
    const f = fakeApi();
    const mcp = new ChatMcp(f.api, 's1');
    f.emit(stateOf('s2', [server({ name: 'other' })]));
    expect(mcp.state).toBeNull();
    f.emit(stateOf('s1', [server({ name: 'mine' })]));
    expect(mcp.state?.servers[0]?.name).toBe('mine');
    mcp.stop();
  });

  it('actions go to the service with the chat and the server name', async () => {
    const f = fakeApi();
    const mcp = new ChatMcp(f.api, 's1');
    await mcp.approve('a');
    await mcp.act('a', 'disable');
    await mcp.submitCallback('a', 'http://localhost/cb?code=1');
    expect(f.request).toHaveBeenCalledWith('mcp.approve', { sessionId: 's1', name: 'a' });
    expect(f.request).toHaveBeenCalledWith('mcp.act', {
      sessionId: 's1',
      name: 'a',
      action: 'disable',
    });
    expect(f.request).toHaveBeenCalledWith('mcp.submitCallback', {
      sessionId: 's1',
      name: 'a',
      url: 'http://localhost/cb?code=1',
    });
    mcp.stop();
  });
});

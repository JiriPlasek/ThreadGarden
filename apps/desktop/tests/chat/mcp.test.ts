import type { McpServer, McpState } from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADDED_AFTER_RESTART,
  type AddForm,
  clearAuthLabel,
  emptyAddForm,
  menuActions,
  primaryAction,
  removeScope,
  removeText,
  REMOVED_AFTER_RESTART,
  SCOPE_LABELS,
  sourceLabel,
  statusLabel,
  toServerConfig,
  TURN_OFF_LABEL,
  validateAddForm,
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

const form = (over: Partial<AddForm> = {}): AddForm => ({
  ...emptyAddForm(),
  name: 'sentry',
  url: 'https://mcp.sentry.dev/mcp',
  ...over,
});

describe('the add form helpers', () => {
  it('validateAddForm accepts a good http and stdio server', () => {
    expect(validateAddForm(form())).toBeNull();
    expect(
      validateAddForm(
        form({
          type: 'stdio',
          command: 'npx',
          args: '-y\npkg',
          pairs: [
            { key: 'API_KEY', value: 'x' },
            { key: '', value: '' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('validateAddForm names the first problem', () => {
    const name = 'Use letters, numbers, - and _ for the name (not starting with -).';
    for (const n of [' ', '-x', 'a b']) expect(validateAddForm(form({ name: n }))).toBe(name);
    const url = 'Enter a full address starting with https:// or http://.';
    expect(validateAddForm(form({ url: '' }))).toBe(url);
    expect(validateAddForm(form({ url: 'ftp://x' }))).toBe(url);
    expect(validateAddForm(form({ type: 'stdio', command: '' }))).toBe('Enter the command to run.');
    expect(validateAddForm(form({ pairs: [{ key: '', value: 'v' }] }))).toBe(
      'Give every header a name.',
    );
    expect(
      validateAddForm(form({ type: 'stdio', command: 'x', pairs: [{ key: '1X', value: 'v' }] })),
    ).toBe('Environment names use letters, numbers and _, not starting with a number.');
    expect(validateAddForm(form({ name: '-x', url: '' }))).toBe(name);
  });

  it('toServerConfig builds the JSON Claude Code takes', () => {
    expect(
      toServerConfig(
        form({
          name: ' sentry ',
          url: ' https://mcp.sentry.dev/mcp ',
          pairs: [
            { key: 'Authorization', value: 'Bearer x' },
            { key: '', value: '' },
          ],
        }),
      ),
    ).toEqual({
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    expect(toServerConfig(form())).toStrictEqual({
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    });
    expect(
      toServerConfig(
        form({
          type: 'stdio',
          command: ' npx ',
          args: '-y\r\n\npkg',
          pairs: [{ key: 'K', value: 'v' }],
        }),
      ),
    ).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
    expect(toServerConfig(form({ type: 'stdio', command: 'npx' }))).toStrictEqual({
      type: 'stdio',
      command: 'npx',
    });
  });

  it('removeScope is the source for local, user and project, null otherwise', () => {
    for (const s of ['local', 'user', 'project'] as const)
      expect(removeScope(server({ source: s }))).toBe(s);
    for (const s of ['claudeai', 'plugin', 'managed', ''])
      expect(removeScope(server({ source: s }))).toBeNull();
  });

  it('the fixed copy', () => {
    expect(SCOPE_LABELS).toEqual({
      local: 'Me, this project',
      user: 'Me, every project',
      project: 'Everyone (.mcp.json)',
    });
    expect(removeText('Ubuntu PC', 'user')).toBe(
      'Claude Code on Ubuntu PC stops using it for Me, every project.',
    );
    expect(ADDED_AFTER_RESTART).toBe('Added. It appears when this chat restarts between turns.');
    expect(REMOVED_AFTER_RESTART).toBe(
      'Removed. It disappears when this chat restarts between turns.',
    );
  });
});

describe('ChatMcp add and remove', () => {
  it('ChatMcp add and remove send the scope and reload', async () => {
    const f = fakeApi();
    f.request.mockImplementation(async (method: string, params: { sessionId: string }) =>
      method === 'mcp.list' ? stateOf(params.sessionId, [server()]) : { restartPending: true },
    );
    const mcp = new ChatMcp(f.api, 's1');
    const config = { type: 'http', url: 'https://x.dev/mcp' } as const;
    expect(await mcp.add('x', 'user', config)).toEqual({ restartPending: true });
    expect(f.request).toHaveBeenCalledWith('mcp.add', {
      sessionId: 's1',
      name: 'x',
      scope: 'user',
      config,
    });
    expect(await mcp.remove('x', 'project')).toEqual({ restartPending: true });
    expect(f.request).toHaveBeenCalledWith('mcp.remove', {
      sessionId: 's1',
      name: 'x',
      scope: 'project',
    });
    await vi.waitFor(() => expect(f.lists()).toBe(2));
    mcp.stop();
  });
});

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

  describe('clearAuth reconnects the server', () => {
    const calls = (f: ReturnType<typeof fakeApi>) =>
      f.request.mock.calls.map((c) => [c[0], (c[1] as { action?: string }).action]);

    it('clearAuth, then reconnect that server, then reload', async () => {
      const f = fakeApi();
      const mcp = new ChatMcp(f.api, 's1');
      await mcp.act('a', 'clearAuth');
      expect(calls(f)).toEqual([
        ['mcp.act', 'clearAuth'],
        ['mcp.act', 'reconnect'],
        ['mcp.list', undefined],
      ]);
      mcp.stop();
    });

    it('a clearAuth error does not reconnect', async () => {
      const f = fakeApi();
      f.request.mockImplementation(async () => {
        throw new Error('nope');
      });
      const mcp = new ChatMcp(f.api, 's1');
      await expect(mcp.act('a', 'clearAuth')).rejects.toThrow('nope');
      expect(calls(f)).toEqual([['mcp.act', 'clearAuth']]);
      mcp.stop();
    });

    it('a failing reconnect rejects with its error', async () => {
      const f = fakeApi();
      f.request.mockImplementation(async (_m: string, p: object) => {
        if ((p as { action?: string }).action === 'reconnect')
          throw new Error('Server "a" is not responding');
        return {};
      });
      const mcp = new ChatMcp(f.api, 's1');
      await expect(mcp.act('a', 'clearAuth')).rejects.toThrow('Server "a" is not responding');
      mcp.stop();
    });

    it('other actions do not reconnect', async () => {
      const f = fakeApi();
      const mcp = new ChatMcp(f.api, 's1');
      await mcp.act('a', 'disable');
      expect(calls(f)).toEqual([
        ['mcp.act', 'disable'],
        ['mcp.list', undefined],
      ]);
      mcp.stop();
    });
  });

  describe('submitCallback reconnects the server', () => {
    const calls = (f: ReturnType<typeof fakeApi>) =>
      f.request.mock.calls.map((c) => [c[0], (c[1] as { action?: string }).action]);

    it('after a successful submit: reconnect that server, then reload', async () => {
      const f = fakeApi();
      const mcp = new ChatMcp(f.api, 's1');
      await mcp.submitCallback('a', 'http://localhost/cb?code=1');
      expect(calls(f)).toEqual([
        ['mcp.submitCallback', undefined],
        ['mcp.act', 'reconnect'],
        ['mcp.list', undefined],
      ]);
      expect(f.request).toHaveBeenCalledWith('mcp.act', {
        sessionId: 's1',
        name: 'a',
        action: 'reconnect',
      });
      mcp.stop();
    });

    it('a failing reconnect after a successful submit rejects with its error', async () => {
      const f = fakeApi();
      f.request.mockImplementation(async (method: string) => {
        if (method === 'mcp.act') throw new Error('Server "a" is not responding');
        return {};
      });
      const mcp = new ChatMcp(f.api, 's1');
      await expect(mcp.submitCallback('a', 'http://localhost/cb?code=1')).rejects.toThrow(
        'Server "a" is not responding',
      );
      mcp.stop();
    });

    it('a submit error does not reconnect', async () => {
      const f = fakeApi();
      f.request.mockImplementation(async (method: string) => {
        if (method === 'mcp.submitCallback') throw new Error('Missing authorization code');
        return {};
      });
      const mcp = new ChatMcp(f.api, 's1');
      await expect(mcp.submitCallback('a', 'http://localhost/cb')).rejects.toThrow(
        'Missing authorization code',
      );
      expect(calls(f).some((c) => c[0] === 'mcp.act')).toBe(false);
      mcp.stop();
    });
  });
});

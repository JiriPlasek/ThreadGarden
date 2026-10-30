import { describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import type {
  CanUseTool,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  StartOptions,
} from '../../src/sdk/adapter.js';

const options = (canUseTool: CanUseTool = async () => ({ behavior: 'allow' })): StartOptions => ({
  cwd: '/proj',
  env: {},
  claudePath: '/bin/claude',
  canUseTool,
});

const msg = (uuid: string): SDKMessage =>
  ({ type: 'system', subtype: 'notification', uuid, session_id: 's' }) as unknown as SDKMessage;

const info = (sessionId: string, lastModified: number): SDKSessionInfo => ({
  sessionId,
  summary: sessionId,
  lastModified,
});

const hist = (uuid: string): SessionMessage => ({
  type: 'user',
  uuid,
  session_id: 'h',
  message: { role: 'user', content: uuid },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

describe('FakeAdapter sessions', () => {
  it('streams emitted messages in order and ends cleanly', async () => {
    const adapter = new FakeAdapter();
    const session = adapter.start(options());
    expect(adapter.lastSession()).toBe(session);
    session.emit(msg('1'));
    session.emit(msg('2'));
    const seen: string[] = [];
    const done = (async () => {
      for await (const m of session.messages) seen.push((m as { uuid: string }).uuid);
    })();
    await Promise.resolve();
    session.emit(msg('3'));
    session.end();
    await done;
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('end(error) makes the iterator throw after draining', async () => {
    const session = new FakeAdapter().start(options());
    session.emit(msg('1'));
    session.end(new Error('process exited'));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const m of session.messages) seen.push((m as { uuid: string }).uuid);
      })(),
    ).rejects.toThrow('process exited');
    expect(seen).toEqual(['1']);
  });

  it('records sends, interrupts, settings and close', async () => {
    const session = new FakeAdapter().start({ ...options(), model: 'opus', effort: 'high' });
    expect(session.options.model).toBe('opus');
    const m = {
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    session.send(m);
    await session.interrupt();
    await session.interrupt();
    await session.setModel('sonnet');
    await session.setPermissionMode('plan');
    expect(session.sent).toEqual([m]);
    expect(session.interrupted).toBe(2);
    expect(session.model).toBe('sonnet');
    expect(session.permissionMode).toBe('plan');
    session.commands = [{ name: 'compact', description: 'Compact', argumentHint: '' }];
    expect(await session.supportedCommands()).toEqual(session.commands);
    expect(await session.supportedModels()).toEqual(session.models);
    expect(await session.accountInfo()).toEqual(session.account);
    session.close();
    expect(session.closed).toBe(true);
    const it = session.messages[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('requestPermission invokes the canUseTool given at start', async () => {
    const canUseTool = vi.fn<CanUseTool>(async () => ({ behavior: 'deny', message: 'no' }));
    const session = new FakeAdapter().start(options(canUseTool));
    const result = await session.requestPermission(
      'Bash',
      { command: 'rm -rf x' },
      { toolUseID: 'toolu_9', title: 'Run rm?' },
    );
    expect(result).toEqual({ behavior: 'deny', message: 'no' });
    expect(canUseTool).toHaveBeenCalledWith(
      'Bash',
      { command: 'rm -rf x' },
      expect.objectContaining({
        toolUseID: 'toolu_9',
        title: 'Run rm?',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('lastSession throws when nothing was started', () => {
    expect(() => new FakeAdapter().lastSession()).toThrow();
  });
});

describe('FakeAdapter history', () => {
  const seeded = () => {
    const a = new FakeAdapter();
    a.sessions.set('old', { info: info('old', 1), messages: [hist('m1')] });
    a.sessions.set('new', { info: info('new', 3), messages: [hist('n1'), hist('n2'), hist('n3')] });
    a.sessions.set('mid', { info: info('mid', 2), messages: [] });
    return a;
  };

  it('lists sessions newest first with limit/offset', async () => {
    const a = seeded();
    expect((await a.listSessions()).map((s) => s.sessionId)).toEqual(['new', 'mid', 'old']);
    expect((await a.listSessions({ limit: 1, offset: 1 })).map((s) => s.sessionId)).toEqual([
      'mid',
    ]);
  });

  it('returns session info and messages', async () => {
    const a = seeded();
    expect(await a.getSessionInfo('mid')).toEqual(info('mid', 2));
    expect(await a.getSessionInfo('nope')).toBeUndefined();
    expect((await a.getSessionMessages('new', { offset: 1, limit: 1 })).map((m) => m.uuid)).toEqual(
      ['n2'],
    );
    expect(await a.getSessionMessages('nope')).toEqual([]);
  });

  it('forks a session up to a message, leaving the original untouched', async () => {
    const a = seeded();
    const { sessionId } = await a.forkSession('new', { upToMessageId: 'n2' });
    expect(sessionId).not.toBe('new');
    expect((await a.getSessionMessages(sessionId)).map((m) => m.uuid)).toEqual(['n1', 'n2']);
    expect((await a.getSessionMessages('new')).length).toBe(3);
    expect(a.forks).toEqual([{ sessionId: 'new', upToMessageId: 'n2', newSessionId: sessionId }]);
    await expect(a.forkSession('nope', {})).rejects.toThrow();
  });
});

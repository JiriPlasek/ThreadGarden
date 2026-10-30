import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage, StartOptions } from '../../src/sdk/adapter.js';
import { RealAdapter, type SdkApi } from '../../src/sdk/real-adapter.js';

/** A stand-in for the SDK's `Query`: an async generator plus the control methods. */
const fakeQuery = (messages: SDKMessage[]) => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const m of messages) yield m;
  }
  return Object.assign(gen(), {
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    supportedCommands: vi.fn(async () => [{ name: 'review', description: '', argumentHint: '' }]),
    supportedModels: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({ apiProvider: 'firstParty' as const })),
    close: vi.fn(),
  });
};

const setup = (messages: SDKMessage[] = []) => {
  const q = fakeQuery(messages);
  const calls: { prompt: AsyncIterable<SDKUserMessage>; options: Options }[] = [];
  const sdk: SdkApi = {
    query: ((p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      calls.push(p);
      return q;
    }) as unknown as SdkApi['query'],
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn(async () => []),
    forkSession: vi.fn(async () => ({ sessionId: 'new' })),
  };
  return { q, calls, sdk, adapter: new RealAdapter(sdk) };
};

const startOptions: StartOptions = {
  cwd: '/p',
  sessionId: '6f1c0e8e-1111-4222-8333-944455556666',
  env: { PATH: '/usr/bin' },
  claudePath: '/bin/claude',
  canUseTool: async () => ({ behavior: 'allow' }),
};

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
});

describe('RealAdapter.start', () => {
  it('calls query with buildQueryOptions and a streaming input queue', async () => {
    const { calls, adapter } = setup();
    const s = adapter.start(startOptions);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({
      cwd: '/p',
      sessionId: startOptions.sessionId,
      pathToClaudeCodeExecutable: '/bin/claude',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });

    s.send(userMessage('one'));
    const it = calls[0]!.prompt[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ done: false, value: userMessage('one') });
    const pending = it.next();
    s.send(userMessage('two'));
    await expect(pending).resolves.toEqual({ done: false, value: userMessage('two') });
  });

  it('streams the query messages', async () => {
    const m1 = { type: 'system', subtype: 'init' } as unknown as SDKMessage;
    const m2 = { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    const { adapter } = setup([m1, m2]);
    const s = adapter.start(startOptions);
    const seen: SDKMessage[] = [];
    for await (const m of s.messages) seen.push(m);
    expect(seen).toEqual([m1, m2]);
  });

  it('forwards control calls to the query', async () => {
    const { q, adapter } = setup();
    const s = adapter.start(startOptions);
    await s.interrupt();
    await s.setModel('sonnet');
    await s.setPermissionMode('plan');
    expect(q.interrupt).toHaveBeenCalledOnce();
    expect(q.setModel).toHaveBeenCalledWith('sonnet');
    expect(q.setPermissionMode).toHaveBeenCalledWith('plan');
    await expect(s.supportedCommands()).resolves.toEqual([
      { name: 'review', description: '', argumentHint: '' },
    ]);
    await expect(s.supportedModels()).resolves.toEqual([]);
    await expect(s.accountInfo()).resolves.toEqual({ apiProvider: 'firstParty' });
  });

  it('close ends the input stream and closes the query; later sends are dropped', async () => {
    const { q, calls, adapter } = setup();
    const s = adapter.start(startOptions);
    const it = calls[0]!.prompt[Symbol.asyncIterator]();
    const pending = it.next();
    s.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(q.close).toHaveBeenCalledOnce();
    s.send(userMessage('late'));
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined });
    s.close(); // idempotent
    expect(q.close).toHaveBeenCalledOnce();
  });
});

describe('RealAdapter session functions', () => {
  it('passes paging without a dir (all projects) and no undefined keys', async () => {
    const { sdk, adapter } = setup();
    await adapter.listSessions({ limit: 5 });
    await adapter.listSessions();
    expect(sdk.listSessions).toHaveBeenNthCalledWith(1, { limit: 5 });
    expect(sdk.listSessions).toHaveBeenNthCalledWith(2, {});
    await adapter.getSessionMessages('s1', { offset: 10, limit: 20 });
    await adapter.getSessionMessages('s1');
    expect(sdk.getSessionMessages).toHaveBeenNthCalledWith(1, 's1', { offset: 10, limit: 20 });
    expect(sdk.getSessionMessages).toHaveBeenNthCalledWith(2, 's1', {});
    await adapter.getSessionInfo('s1');
    expect(sdk.getSessionInfo).toHaveBeenCalledWith('s1');
  });

  it('forkSession passes upToMessageId only when given', async () => {
    const { sdk, adapter } = setup();
    await expect(adapter.forkSession('s1', { upToMessageId: 'u1' })).resolves.toEqual({
      sessionId: 'new',
    });
    await adapter.forkSession('s1', {});
    expect(sdk.forkSession).toHaveBeenNthCalledWith(1, 's1', { upToMessageId: 'u1' });
    expect(sdk.forkSession).toHaveBeenNthCalledWith(2, 's1', {});
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults, type ChatItem } from '@threadgarden/protocol';
import { LiveSession, type LiveSessionDeps } from '../../src/chat/live-session.js';
import { Normalizer } from '../../src/chat/normalize.js';
import { CodexAdapter, codexPermissions } from '../../src/sdk/codex-adapter.js';
import {
  CodexRpcError,
  type CodexConnection,
  type ConnectCodex,
} from '../../src/sdk/codex-client.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { MemoryRegistry } from '../chat/live-helpers.js';

type Rec = Record<string, unknown>;
let dir: string;
let sessions: LiveSession[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-codex-'));
  sessions = [];
});
afterEach(async () => {
  for (const session of sessions) {
    session.end();
    await session.whenEnded();
  }
  rmSync(dir, { recursive: true, force: true });
});

const harness = (responses: Record<string, Rec> = {}) => {
  const connections: {
    client: CodexConnection;
    env: NodeJS.ProcessEnv;
    event(method: string, params?: Rec, id?: number): void;
    exit(error: Error): void;
    calls: { method: string; params: Rec }[];
    replies: { id: number | string; result: unknown }[];
  }[] = [];
  let turns = 0;
  const connect: ConnectCodex = (_env, onMessage, onExit) => {
    const calls: { method: string; params: Rec }[] = [];
    const replies: { id: number | string; result: unknown }[] = [];
    const client: CodexConnection = {
      request: vi.fn(async (method, params): Promise<Rec> => {
        calls.push({ method, params });
        if (responses[method]) return responses[method]!;
        if (method === 'thread/start' || method === 'thread/resume')
          return {
            thread: { id: 'thread-123' },
            model: 'test-model',
            sandbox: { type: 'readOnly' },
          };
        if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } };
        if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
        if (method === 'model/list')
          return {
            data: [
              {
                model: 'test-model',
                displayName: 'Test model',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low' },
                  { reasoningEffort: 'high' },
                ],
              },
            ],
            nextCursor: null,
          };
        return {};
      }),
      notify: vi.fn(),
      reply: (id, result) => {
        replies.push({ id, result });
      },
      reject: vi.fn(),
      close: vi.fn(),
    };
    connections.push({
      client,
      env: _env,
      calls,
      replies,
      event: (method, params = {}, id) =>
        onMessage({ method, params, ...(id === undefined ? {} : { id }) }),
      exit: onExit,
    });
    return client;
  };
  const claude = new FakeAdapter();
  const codex = new CodexAdapter(dir, connect);
  const adapter = new MultiAdapter(claude, codex);
  const create = (
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' = 'default',
    deps: Partial<LiveSessionDeps> = {},
  ) => {
    const session = LiveSession.create(
      dir,
      { text: 'hello' },
      {
        adapter,
        registry: new MemoryRegistry(),
        claudePath: '',
        env: {},
        now: Date.now,
        emit: () => {},
        model: 'codex:test-model',
        permissionMode,
        onError: () => {},
        ...deps,
      },
    );
    sessions.push(session);
    return session;
  };
  const running = async () => {
    await vi.waitFor(() =>
      expect(connections.at(-1)?.calls.some((c) => c.method === 'turn/start')).toBe(true),
    );
    return connections.at(-1)!;
  };
  return { adapter, claude, codex, create, running, connections, connect };
};

describe('Codex provider', () => {
  it('uses native Plan mode and switches to editing only after the user chooses it', async () => {
    const h = harness();
    const session = h.create('plan');
    const c = await h.running();
    expect(c.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'test-model', developer_instructions: null },
      },
    });
    await expect(session.setPermissionMode('acceptEdits')).rejects.toThrow('current turn');
    c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    await session.setPermissionMode('acceptEdits');
    session.send({ text: 'Implement the plan.' });
    await vi.waitFor(() =>
      expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2),
    );
    expect(c.calls.filter((call) => call.method === 'turn/start')[1]?.params).toMatchObject({
      sandboxPolicy: { type: 'workspaceWrite' },
      collaborationMode: { mode: 'default' },
    });
  });

  it('shows native context and records token usage without inventing dollar cost', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event('item/completed', { item: { type: 'agentMessage', id: 'reply', text: 'Done' } });
    c.event('thread/tokenUsage/updated', {
      tokenUsage: {
        last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
        modelContextWindow: 1000,
      },
    });
    c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', durationMs: 250 } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    expect(session.header.contextUsage).toEqual({ used: 120, max: 1000 });
    expect(session.header.costUsd).toBeUndefined();
    const history = await h.adapter.getSessionMessages(session.sessionId);
    expect(history).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          usage: {
            input_tokens: 60,
            cache_read_input_tokens: 40,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
          },
        }),
      }),
    );
  });

  it('preserves an imported thread custom sandbox, login home and provider on resume', async () => {
    const h = harness({
      'thread/resume': {
        thread: { id: 'native-thread' },
        model: 'test-model',
        modelProvider: 'custom',
        approvalPolicy: 'untrusted',
        sandbox: { type: 'externalSandbox' },
        reasoningEffort: 'high',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'test-model',
            reasoning_effort: 'high',
            developer_instructions: 'Keep the saved native instructions.',
          },
        },
      },
    });
    const id = 'codex-00000000-0000-4000-8000-000000000001';
    h.codex.store.save({
      id,
      threadId: 'native-thread',
      cwd: dir,
      home: dir,
      modelProvider: 'custom',
      preservePermissions: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const session = LiveSession.resume(id, dir, {
      adapter: h.adapter,
      registry: new MemoryRegistry(),
      env: {},
      claudePath: '',
      now: Date.now,
      emit: () => {},
      onError: () => {},
    });
    sessions.push(session);
    session.send({ text: 'Continue' });
    const c = await h.running();
    const resume = c.calls.find((call) => call.method === 'thread/resume')!.params;
    expect(resume).toMatchObject({ modelProvider: 'custom', excludeTurns: true });
    expect(resume).not.toHaveProperty('sandbox');
    expect(resume).not.toHaveProperty('approvalPolicy');
    expect(c.calls.find((call) => call.method === 'turn/start')?.params).not.toHaveProperty(
      'sandboxPolicy',
    );
    expect(c.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      collaborationMode: {
        settings: { developer_instructions: 'Keep the saved native instructions.' },
      },
    });
    expect(session.header.permissionMode).toBe('custom');
    expect(session.header.effort).toBe('high');
  });
  it('maps explicit full access to YOLO and keeps the other modes sandboxed', () => {
    expect(codexPermissions('bypassPermissions')).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    expect(codexPermissions('default')).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
    expect(codexPermissions('acceptEdits')).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(codexPermissions('auto')).toMatchObject({
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    });
    expect(codexPermissions('plan')).toMatchObject({ sandbox: 'read-only' });
  });

  it('discovers models before a chat exists, launches the right runtime and preserves Claude routing', async () => {
    const h = harness();
    expect(await h.adapter.models()).toMatchObject([
      {
        value: 'codex:test-model',
        displayName: 'Test model',
        supportedEffortLevels: ['low', 'high'],
      },
    ]);
    expect(h.connections[0]!.client.notify).toHaveBeenCalledWith('initialized', {});
    expect(h.connections[0]!.client.close).toHaveBeenCalledOnce();
    const session = h.create('bypassPermissions');
    const connection = await h.running();
    expect(session.sessionId).toMatch(/^codex-/);
    expect(h.claude.started).toHaveLength(0);
    expect(connection.calls.find((c) => c.method === 'thread/start')?.params).toMatchObject({
      cwd: dir,
      model: 'test-model',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(connection.calls.find((c) => c.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    await expect(session.setModel('sonnet')).rejects.toThrow('new chat');
    const claude = h.adapter.start({
      cwd: dir,
      env: {},
      claudePath: '',
      model: 'sonnet',
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    expect(h.claude.started).toHaveLength(1);
    await expect(claude.setModel('codex:test-model')).rejects.toThrow('new chat');
    claude.close();
  });

  it('streams one reply, thinking and tool results into the shared UI, then restores history', async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    connection.event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'Hel' });
    connection.event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'lo!' });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({ kind: 'assistantText', markdown: 'Hello!', streaming: true }),
      ),
    );
    connection.event('item/completed', {
      item: { id: 'answer-1', type: 'agentMessage', text: 'Hello!' },
    });
    connection.event('item/completed', {
      item: { id: 'reason-1', type: 'reasoning', summary: ['A concise summary'] },
    });
    connection.event('item/started', {
      item: { id: 'command-1', type: 'commandExecution', command: 'pwd' },
    });
    connection.event('item/completed', {
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'pwd',
        status: 'completed',
        aggregatedOutput: dir,
      },
    });
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    const items = session.snapshot(100).items;
    expect(items.filter((i) => i.kind === 'assistantText')).toEqual([
      expect.objectContaining({ id: 'answer-1', markdown: 'Hello!', streaming: false }),
    ]);
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'thinking', text: 'A concise summary' }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'toolCall', status: 'ok', resultText: dir }),
    );
    expect(session.header.auth?.label).toBe('Pro subscription');
    const normalizer = new Normalizer();
    const restored = new Map<string, ChatItem>();
    for (const message of await h.adapter.getSessionMessages(session.sessionId)) {
      for (const item of normalizer.push(message).items) restored.set(item.id, item);
    }
    expect([...restored.values()].filter((i) => i.kind === 'assistantText')).toEqual(
      items.filter((i) => i.kind === 'assistantText'),
    );
    expect(await h.adapter.listSessions()).toMatchObject([
      { sessionId: session.sessionId, firstPrompt: 'hello', cwd: dir },
    ]);
  });

  it('bridges approval and denial, and cancels pending approvals on interruption', async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    connection.event(
      'item/commandExecution/requestApproval',
      { itemId: 'command-1', command: 'pwd', reason: 'Needs access' },
      71,
    );
    await vi.waitFor(() => expect(session.status).toBe('needsYou'));
    session.respond('codex-71', { decision: 'allow' });
    await vi.waitFor(() =>
      expect(connection.replies).toContainEqual({ id: 71, result: { decision: 'accept' } }),
    );
    connection.event('item/fileChange/requestApproval', { itemId: 'patch-1' }, 72);
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    session.respond('codex-72', { decision: 'deny', reason: 'No' });
    await vi.waitFor(() =>
      expect(connection.replies).toContainEqual({ id: 72, result: { decision: 'decline' } }),
    );
    connection.event(
      'item/commandExecution/requestApproval',
      { itemId: 'command-2', command: 'pwd' },
      73,
    );
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    await session.interrupt();
    expect(connection.calls).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-123', turnId: 'turn-1' },
    });
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(0));
    expect(connection.replies.some((reply) => reply.id === 73)).toBe(false);
  });

  it("answers a sub-agent's approval request instead of leaving its turn hanging", async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    connection.event(
      'item/commandExecution/requestApproval',
      { threadId: 'child-thread', itemId: 'child-command', command: 'ls' },
      81,
    );
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    session.respond('codex-81', { decision: 'allow' });
    await vi.waitFor(() =>
      expect(connection.replies).toContainEqual({ id: 81, result: { decision: 'accept' } }),
    );
    connection.event('item/fileChange/requestApproval', { threadId: 'child-thread' }, 82);
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    connection.event('serverRequest/resolved', { threadId: 'child-thread', requestId: 82 });
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(0));
    connection.event('item/tool/unknownRequest', { threadId: 'child-thread' }, 83);
    expect(connection.client.reject).toHaveBeenCalledWith(83, expect.any(String));
    // A sub-agent's ordinary events still stay out of the parent's transcript.
    connection.event('item/completed', {
      threadId: 'child-thread',
      item: { id: 'child-answer', type: 'agentMessage', text: 'from the child' },
    });
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    expect(
      session
        .snapshot(100)
        .items.some((i) => i.kind === 'assistantText' && i.id === 'child-answer'),
    ).toBe(false);
  });

  it('shows a rejected turn/start as a failed turn and keeps the chat usable', async () => {
    let failNext = true;
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    const request = vi.mocked(connection.client.request);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, params: Rec) => {
      if (method === 'turn/start' && failNext) {
        failNext = false;
        throw new Error('Codex rejected the model and effort');
      }
      return original(method, params);
    });
    session.send({ text: 'this one fails' });
    await vi.waitFor(() =>
      expect(
        session
          .snapshot(100)
          .items.some(
            (i) =>
              i.kind === 'assistantText' &&
              i.markdown.includes('Codex rejected the model and effort'),
          ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    expect(connection.client.close).not.toHaveBeenCalled();
    session.send({ text: 'this one works' });
    await vi.waitFor(() =>
      expect(
        connection.calls.filter((c) => c.method === 'turn/start').at(-1)!.params.input,
      ).toEqual([{ type: 'text', text: 'this one works', text_elements: [] }]),
    );
    expect(session.status).toBe('working');
  });

  it('applies reasoning controls to a turn started after completion', async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    await session.setEffort('high');
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    session.send({ text: 'second' });
    await vi.waitFor(() =>
      expect(connection.calls.filter((c) => c.method === 'turn/start')).toHaveLength(2),
    );
    expect(connection.calls.filter((c) => c.method === 'turn/start')[1]!.params).toMatchObject({
      effort: 'high',
      input: [{ type: 'text', text: 'second' }],
    });
    connection.event('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    await expect(session.setEffort('max')).rejects.toThrow('does not support');
  });

  it('shows reasoning summaries and tool output while the native tool is still running', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event('item/reasoning/summaryTextDelta', {
      itemId: 'reason',
      summaryIndex: 0,
      delta: 'Checking ',
    });
    c.event('item/reasoning/summaryTextDelta', {
      itemId: 'reason',
      summaryIndex: 0,
      delta: 'the result',
    });
    c.event('item/started', {
      item: { id: 'shell', type: 'commandExecution', command: 'echo hello' },
    });
    c.event('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'hel' });
    c.event('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'lo' });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'thinking',
          id: 'reason',
          text: 'Checking the result',
        }),
      ),
    );
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'toolCall',
        toolUseId: 'shell',
        status: 'running',
        resultText: 'hello',
      }),
    );
    c.event('item/completed', {
      item: { id: 'reason', type: 'reasoning', summary: ['Checking the result'] },
    });
    c.event('item/completed', {
      item: {
        id: 'shell',
        type: 'commandExecution',
        aggregatedOutput: 'hello final',
        status: 'completed',
      },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'toolCall',
          toolUseId: 'shell',
          status: 'ok',
          resultText: 'hello final',
        }),
      ),
    );
    expect(session.snapshot(100).items.filter((item) => item.id === 'reason')).toHaveLength(1);
  });

  it('nests early child and grandchild content beneath their native spawn calls without ending the main turn', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event('item/started', {
      threadId: 'thread-123',
      item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [] },
    });
    c.event('thread/started', { thread: { id: 'child', parentThreadId: 'thread-123' } });
    c.event('item/agentMessage/delta', {
      threadId: 'child',
      turnId: 'child-turn',
      itemId: 'child-reply',
      delta: 'child live',
    });
    c.event('item/completed', {
      threadId: 'thread-123',
      item: {
        id: 'spawn',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        receiverThreadIds: ['child'],
      },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'child live',
          parentToolUseId: 'spawn',
          streaming: true,
        }),
      ),
    );
    c.event('item/completed', {
      threadId: 'child',
      item: { id: 'child-reply', type: 'agentMessage', text: 'child final' },
    });
    c.event('item/completed', {
      threadId: 'child',
      item: {
        id: 'nested-spawn',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        receiverThreadIds: ['grandchild'],
      },
    });
    c.event('item/completed', {
      threadId: 'grandchild',
      item: { id: 'grandchild-reply', type: 'agentMessage', text: 'nested final' },
    });
    c.event('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    });
    c.event('turn/completed', {
      threadId: 'grandchild',
      turn: { id: 'nested-turn', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'nested final',
          parentToolUseId: 'nested-spawn',
        }),
      ),
    );
    expect(session.status).toBe('working');
    expect(session.snapshot(100).items.filter((item) => item.kind === 'result')).toHaveLength(0);
    const history = await h.adapter.getSessionMessages(session.sessionId);
    expect(history).toContainEqual(
      expect.objectContaining({
        uuid: 'child-reply',
        parent_tool_use_id: 'spawn',
        parent_agent_id: 'child',
      }),
    );
  });

  it('maps modern sub-agent activity to its child conversation and completes the original call', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event('item/completed', {
      threadId: 'thread-123',
      item: {
        id: 'native-spawn',
        type: 'subAgentActivity',
        kind: 'started',
        model: 'child-model',
        agentThreadId: 'child',
        agentPath: '/root/child',
      },
    });
    c.event('item/completed', {
      threadId: 'child',
      item: { id: 'child-text', type: 'agentMessage', text: 'child done' },
    });
    c.event('item/completed', {
      threadId: 'thread-123',
      item: {
        id: 'native-finished',
        type: 'subAgentActivity',
        kind: 'completed',
        agentThreadId: 'child',
        agentPath: '/root/child',
      },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'child done',
          parentToolUseId: 'native-spawn',
        }),
      ),
    );
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'toolCall',
        toolUseId: 'native-spawn',
        name: 'Agent',
        status: 'ok',
      }),
    );
    const messages = await h.adapter.getSessionMessages(session.sessionId);
    expect(messages).toContainEqual(
      expect.objectContaining({
        uuid: 'child-text',
        message: expect.objectContaining({ model: 'child-model' }),
      }),
    );
    expect(session.tasks()).toContainEqual(
      expect.objectContaining({
        taskId: 'codex-agent-child',
        toolUseId: 'native-spawn',
        status: 'completed',
        model: 'child-model',
      }),
    );
    expect(session.snapshot(100).items.some((item) => item.kind === 'unknown')).toBe(false);
    c.event('item/completed', {
      item: {
        id: 'known-interaction',
        type: 'subAgentActivity',
        kind: 'interacted',
        agentThreadId: 'child',
        agentPath: '/root/child',
      },
    });
    c.event('item/completed', {
      threadId: 'child',
      item: { id: 'known-child-followup', type: 'agentMessage', text: 'continued child' },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'continued child',
          parentToolUseId: 'native-spawn',
        }),
      ),
    );
    expect(session.tasks()).toContainEqual(
      expect.objectContaining({
        taskId: 'codex-agent-child',
        toolUseId: 'native-spawn',
        status: 'running',
      }),
    );
    expect(
      session
        .snapshot(100)
        .items.some((item) => item.kind === 'toolCall' && item.toolUseId === 'known-interaction'),
    ).toBe(false);
  });

  it('keeps the main turn idle when a background child continues speaking', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event('item/completed', {
      threadId: 'thread-123',
      item: {
        id: 'spawn-idle',
        type: 'subAgentActivity',
        kind: 'started',
        model: 'child-model',
        agentThreadId: 'child',
        agentPath: '/root/child',
      },
    });
    c.event('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    c.event('item/completed', {
      threadId: 'child',
      turnId: 'child-turn',
      item: { id: 'background-text', type: 'agentMessage', text: 'still working' },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'still working',
          parentToolUseId: 'spawn-idle',
        }),
      ),
    );
    expect(session.status).toBe('idle');
    expect(session.header.model).toBe('codex:test-model');
    expect(session.tasks()).toContainEqual(
      expect.objectContaining({
        taskId: 'codex-agent-child',
        status: 'running',
        model: 'child-model',
      }),
    );
  });

  it('resolves approval lifetimes per native thread while background children continue', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    c.event(
      'item/commandExecution/requestApproval',
      { threadId: 'thread-123', itemId: 'main-command' },
      91,
    );
    c.event(
      'item/commandExecution/requestApproval',
      { threadId: 'child', itemId: 'child-command' },
      92,
    );
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(2));
    c.event('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' },
    });
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    expect(session.pendingRequests()[0]).toMatchObject({ requestId: 'codex-91' });
    session.respond('codex-91', { decision: 'allow' });
    await vi.waitFor(() =>
      expect(c.replies).toContainEqual({ id: 91, result: { decision: 'accept' } }),
    );
    c.event(
      'item/commandExecution/requestApproval',
      { threadId: 'child', itemId: 'next-child-command' },
      93,
    );
    await vi.waitFor(() => expect(session.pendingRequests()).toHaveLength(1));
    c.event('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.pendingRequests()[0]).toMatchObject({ requestId: 'codex-93' });
    session.respond('codex-93', { decision: 'allow' });
    await vi.waitFor(() =>
      expect(c.replies).toContainEqual({ id: 93, result: { decision: 'accept' } }),
    );
  });

  it('routes an existing child first observed through interaction after native resume', async () => {
    const h = harness();
    const id = 'codex-00000000-0000-4000-8000-000000000002';
    h.codex.store.save({
      id,
      threadId: 'thread-123',
      cwd: dir,
      createdAt: 1,
      updatedAt: 1,
      model: 'codex:test-model',
    });
    const session = LiveSession.resume(id, dir, {
      adapter: h.adapter,
      registry: new MemoryRegistry(),
      env: {},
      claudePath: '',
      now: Date.now,
      emit: () => {},
      onError: () => {},
    });
    sessions.push(session);
    const c = h.connections.at(-1)!;
    await vi.waitFor(() =>
      expect(c.calls.some((call) => call.method === 'thread/resume')).toBe(true),
    );
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    c.event('item/completed', {
      threadId: 'thread-123',
      item: {
        id: 'existing-interaction',
        type: 'subAgentActivity',
        kind: 'interacted',
        agentThreadId: 'existing-child',
        agentPath: '/root/existing',
      },
    });
    c.event('item/completed', {
      threadId: 'existing-child',
      item: { id: 'resumed-child-reply', type: 'agentMessage', text: 'existing child reply' },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(100).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'existing child reply',
          parentToolUseId: 'existing-interaction',
        }),
      ),
    );
    expect(session.snapshot(100).items).toContainEqual(
      expect.objectContaining({
        kind: 'toolCall',
        name: 'Agent',
        toolUseId: 'existing-interaction',
      }),
    );
    expect(session.status).toBe('idle');
    expect(session.tasks()).toContainEqual(
      expect.objectContaining({
        taskId: 'codex-agent-existing-child',
        toolUseId: 'existing-interaction',
        status: 'running',
      }),
    );
    expect(c.calls.some((call) => call.method === 'thread/read')).toBe(false);
  });

  it('continues routing sequential children after the bounded live registry fills', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    for (let i = 0; i < 129; i++) {
      c.event('item/completed', {
        item: {
          id: `spawn-${i}`,
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: `child-${i}`,
          agentPath: `/root/child-${i}`,
        },
      });
      c.event('item/completed', {
        threadId: `child-${i}`,
        item: { id: `reply-${i}`, type: 'agentMessage', text: `reply ${i}` },
      });
      c.event('item/completed', {
        item: {
          id: `completed-${i}`,
          type: 'subAgentActivity',
          kind: 'completed',
          agentThreadId: `child-${i}`,
        },
      });
    }
    await vi.waitFor(() =>
      expect(session.snapshot(1000).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'reply 128',
          parentToolUseId: 'spawn-128',
        }),
      ),
    );
    c.event('item/completed', {
      item: {
        id: 'reactivated-child',
        type: 'subAgentActivity',
        kind: 'interacted',
        agentThreadId: 'child-0',
        agentPath: '/root/child-0',
      },
    });
    c.event('item/completed', {
      threadId: 'child-0',
      item: { id: 'reactivated-reply', type: 'agentMessage', text: 'reactivated child' },
    });
    await vi.waitFor(() =>
      expect(session.snapshot(1000).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'reactivated child',
          parentToolUseId: 'reactivated-child',
        }),
      ),
    );
  });

  it('explains when too many active children prevent live output routing', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    for (let i = 0; i < 129; i++)
      c.event('item/completed', {
        item: {
          id: `spawn-${i}`,
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: `active-child-${i}`,
        },
      });
    await vi.waitFor(() =>
      expect(session.snapshot(1000).items).toContainEqual(
        expect.objectContaining({
          kind: 'system',
          level: 'warning',
          text: expect.stringContaining('128 active Codex agents'),
        }),
      ),
    );
  });

  it('recycles completed legacy child turns and restarts their task only when another turn begins', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    for (let i = 0; i < 129; i++) {
      c.event('item/completed', {
        item: {
          id: `legacy-${i}`,
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          receiverThreadIds: [`legacy-child-${i}`],
        },
      });
      c.event('turn/started', { threadId: `legacy-child-${i}`, turn: { id: `child-turn-${i}` } });
      c.event('item/completed', {
        threadId: `legacy-child-${i}`,
        item: { id: `legacy-reply-${i}`, type: 'agentMessage', text: `legacy reply ${i}` },
      });
      c.event('turn/completed', {
        threadId: `legacy-child-${i}`,
        turn: { id: `child-turn-${i}`, status: 'completed' },
      });
    }
    await vi.waitFor(() =>
      expect(session.snapshot(1000).items).toContainEqual(
        expect.objectContaining({
          kind: 'assistantText',
          markdown: 'legacy reply 128',
          parentToolUseId: 'legacy-128',
        }),
      ),
    );
    expect(
      session.snapshot(1000).tasks.find((task) => task.taskId === 'codex-agent-legacy-child-128')
        ?.status,
    ).toBe('completed');
    c.event('turn/started', { threadId: 'legacy-child-128', turn: { id: 'followup-turn' } });
    await vi.waitFor(() =>
      expect(
        session.snapshot(1000).tasks.find((task) => task.taskId === 'codex-agent-legacy-child-128')
          ?.status,
      ).toBe('running'),
    );
  });

  it('keeps slash commands queued for native command handling after the active turn', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    session.send({ text: '/compact' });
    session.send({ text: 'after command' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0);
    expect(session.queued().map((m) => m.text)).toEqual(['/compact', 'after command']);
    c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() =>
      expect(c.calls.some((call) => call.method === 'thread/compact/start')).toBe(true),
    );
    c.event('turn/started', { turn: { id: 'native-compact' } });
    session.send({ text: 'during compaction' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0);
    expect(session.queued().map((m) => m.text)).toEqual(['after command', 'during compaction']);
    c.event('turn/completed', { turn: { id: 'native-compact', status: 'completed' } });
    await vi.waitFor(() =>
      expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1),
    );
    expect(c.calls.find((call) => call.method === 'turn/steer')?.params).toMatchObject({
      expectedTurnId: 'turn-2',
      input: [{ type: 'text', text: 'during compaction', text_elements: [] }],
    });
  });

  it('steers active turns and acknowledges input only after native acceptance', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    const original = vi.mocked(c.client.request).getMockImplementation()!;
    let accept!: (value: Rec) => void;
    vi.spyOn(c.client, 'request').mockImplementation((method, params) =>
      method === 'turn/steer'
        ? new Promise<Rec>((resolve) => {
            c.calls.push({ method, params });
            accept = resolve;
          })
        : original(method, params),
    );
    session.send({ text: 'second' });
    await vi.waitFor(() => expect(c.calls.some((call) => call.method === 'turn/steer')).toBe(true));
    expect(session.queued().map((m) => m.text)).toEqual(['second']);
    await expect(session.withdraw(session.queued()[0]!.id)).rejects.toMatchObject({
      code: 'NOT_QUEUED',
    });
    expect(c.calls.find((call) => call.method === 'turn/steer')?.params).toMatchObject({
      threadId: 'thread-123',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'second', text_elements: [] }],
    });
    accept({ turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.queued().map((m) => m.text)).toEqual(['second']);
    c.event('item/started', {
      item: {
        type: 'userMessage',
        id: 'native-user',
        clientId: c.calls.find((call) => call.method === 'turn/steer')?.params.clientUserMessageId,
      },
    });
    await vi.waitFor(() => expect(session.queued()).toEqual([]));
    expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('retries a rejected steering precondition once in the next turn without duplicating input', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    const original = vi.mocked(c.client.request).getMockImplementation()!;
    vi.spyOn(c.client, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/steer') {
        c.calls.push({ method, params });
        c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
        throw new CodexRpcError('no active turn to steer', -32600);
      }
      return original(method, params);
    });
    session.send({ text: 'race' });
    await vi.waitFor(() =>
      expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2),
    );
    await vi.waitFor(() => expect(session.queued()).toEqual([]));
    expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
    expect(c.calls.filter((call) => call.method === 'turn/start')[1]?.params.input).toEqual([
      { type: 'text', text: 'race', text_elements: [] },
    ]);
    expect(
      session.snapshot(100).items.filter((item) => item.kind === 'user' && item.text === 'race'),
    ).toHaveLength(1);
  });

  it('does not replay ambiguous steering failures or finish the active turn', async () => {
    const h = harness();
    const session = h.create();
    const c = await h.running();
    const original = vi.mocked(c.client.request).getMockImplementation()!;
    vi.spyOn(c.client, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/steer') {
        c.calls.push({ method, params });
        throw new Error('Codex turn/steer timed out');
      }
      return original(method, params);
    });
    session.send({ text: 'uncertain' });
    await vi.waitFor(() =>
      expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1),
    );
    expect(session.queued().map((m) => m.text)).toEqual(['uncertain']);
    expect(session.status).toBe('working');
    expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('Stop returns only unsubmitted messages and waits for in-flight steering before interrupting', async () => {
    const returned: string[] = [];
    const h = harness();
    const session = h.create('default', {
      onReturned: (_id, messages) => returned.push(...messages.map((m) => m.text)),
    });
    const c = await h.running();
    const original = vi.mocked(c.client.request).getMockImplementation()!;
    let accept!: (value: Rec) => void;
    vi.spyOn(c.client, 'request').mockImplementation((method, params) => {
      if (method === 'turn/steer') {
        c.calls.push({ method, params });
        return new Promise<Rec>((resolve) => {
          accept = resolve;
        });
      }
      return original(method, params);
    });
    session.send({ text: 'submitted' });
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    session.send({ text: 'unsent' });
    const stop = session.interrupt();
    expect(c.calls.some((call) => call.method === 'turn/interrupt')).toBe(false);
    c.event('item/started', {
      item: {
        type: 'userMessage',
        id: 'native-user',
        clientId: c.calls.find((call) => call.method === 'turn/steer')?.params.clientUserMessageId,
      },
    });
    accept({ turnId: 'turn-1' });
    await stop;
    await vi.waitFor(() => expect(returned).toEqual(['unsent']));
    expect(c.calls.find((call) => call.method === 'turn/interrupt')?.params.turnId).toBe('turn-1');
    expect(c.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
  });

  it('steers messages sent during initialization once the first turn is active', async () => {
    const h = harness();
    const session = h.create();
    expect(session.send({ text: 'arrived during startup' })).toEqual({ queued: true });
    const c = await h.running();
    await vi.waitFor(() => expect(c.calls.some((call) => call.method === 'turn/steer')).toBe(true));
    expect(c.calls.find((call) => call.method === 'turn/steer')?.params.expectedTurnId).toBe(
      'turn-1',
    );
    c.event('item/started', {
      item: {
        type: 'userMessage',
        id: 'startup-user',
        clientId: c.calls.find((call) => call.method === 'turn/steer')?.params.clientUserMessageId,
      },
    });
    await vi.waitFor(() => expect(session.queued()).toEqual([]));
    expect(c.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('resumes the saved Codex thread with the saved model and permission policy after restart', async () => {
    const h = harness();
    const session = h.create('bypassPermissions');
    const first = await h.running();
    first.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    await session.setEffort('high');
    session.end();
    await session.whenEnded();
    const restarted = new MultiAdapter(h.claude, new CodexAdapter(dir, h.connect));
    const resumed = LiveSession.resume(session.sessionId, dir, {
      adapter: restarted,
      registry: new MemoryRegistry(),
      env: {},
      claudePath: '',
      now: Date.now,
      emit: () => {},
      onError: () => {},
    });
    sessions.push(resumed);
    const second = h.connections.at(-1)!;
    await vi.waitFor(() =>
      expect(second.calls.some((c) => c.method === 'thread/resume')).toBe(true),
    );
    expect(second.calls.find((c) => c.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-123',
      model: 'test-model',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    resumed.send({ text: 'continue' });
    await vi.waitFor(() =>
      expect(second.calls.some((call) => call.method === 'turn/start')).toBe(true),
    );
    expect(second.calls.find((call) => call.method === 'turn/start')?.params.effort).toBe('high');
    expect(await restarted.resumeCommand(session.sessionId)).toBe('codex resume thread-123');
  });

  it('marks a dead app-server as failed and closes its connection', async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    connection.exit(new Error('Codex died'));
    await vi.waitFor(() => expect(session.status).toBe('failed'));
    expect(connection.client.close).toHaveBeenCalledOnce();
    expect(
      session.snapshot(100).items.some((i) => i.kind === 'system' && i.text.includes('Codex died')),
    ).toBe(true);
  });
});

it('executes compact natively instead of sending slash text to the model', async () => {
  const h = harness();
  const session = h.create();
  const c = await h.running();
  c.event('turn/completed', {
    threadId: 'thread-123',
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(await session.supportedCommands()).toEqual([
    { name: 'compact', description: 'Compact the conversation context', argumentHint: '' },
  ]);
  session.send({ text: '/compact' });
  await vi.waitFor(() =>
    expect(c.calls.some((x) => x.method === 'thread/compact/start')).toBe(true),
  );
  expect(c.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1);
});

it('rejects unsupported Codex slash commands instead of treating them as model prompts', async () => {
  const h = harness();
  const session = h.create();
  const c = await h.running();
  c.event('turn/completed', {
    threadId: 'thread-123',
    turn: { id: 'turn-1', status: 'completed' },
  });
  session.send({ text: '/unknown' });
  await vi.waitFor(() => expect(session.status).toBe('idle'));
  expect(c.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1);
});

it('generates Codex titles in a tool-less ephemeral native thread without Claude', async () => {
  const h = harness({ 'config/read': { config: { mcp_servers: { private: {} } } } });
  const sourceSessionId = 'codex-11111111-1111-4111-8111-111111111111';
  h.codex.store.save({
    id: sourceSessionId,
    cwd: dir,
    home: '/source-login',
    model: 'codex:test-model',
    modelProvider: 'custom',
    createdAt: 1,
    updatedAt: 1,
  });
  h.adapter.configure({ ...settingsDefaults, codexHome: '/configured-login' });
  const controller = new AbortController();
  const answer = h.adapter.oneShot({
    sourceSessionId,
    prompt: 'Title this chat',
    systemPrompt: 'Return only a title',
    model: 'codex:default',
    cwd: dir,
    env: {},
    claudePath: '',
    sessionId: 'title-query',
    signal: controller.signal,
  });
  await vi.waitFor(() =>
    expect(h.connections.at(-1)?.calls.some((c) => c.method === 'turn/start')).toBe(true),
  );
  const c = h.connections.at(-1)!;
  expect(c.env.CODEX_HOME).toBe('/source-login');
  const start = c.calls.find((c) => c.method === 'thread/start')!.params;
  expect(start).toMatchObject({
    model: 'test-model',
    modelProvider: 'custom',
    ephemeral: true,
    approvalPolicy: 'never',
    dynamicTools: [],
    environments: [],
    selectedCapabilityRoots: [],
    config: {
      'features.shell_tool': false,
      'features.unified_exec': false,
      'tools.update_plan.enabled': false,
      mcp_servers: { private: { enabled: false } },
    },
  });
  c.event('item/completed', {
    threadId: 'thread-123',
    turnId: 'turn-1',
    item: { id: 'answer', type: 'agentMessage', text: 'Native Codex chat titles' },
  });
  c.event('turn/completed', {
    threadId: 'thread-123',
    turn: { id: 'turn-1', status: 'completed' },
  });
  expect(await answer).toBe('Native Codex chat titles');
  expect(h.claude.oneShots).toHaveLength(0);
  expect(c.client.close).toHaveBeenCalled();
});

it('does not reuse the preceding reply or usage when compacting', async () => {
  const h = harness();
  const session = h.create();
  const c = await h.running();
  c.event('item/completed', { item: { type: 'agentMessage', id: 'reply', text: 'Done' } });
  c.event('thread/tokenUsage/updated', {
    tokenUsage: { last: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 1000 },
  });
  c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await vi.waitFor(() => expect(session.status).toBe('idle'));
  const before = h.codex.store
    .messages(session.sessionId)
    .filter((m) => m.type === 'assistant').length;
  session.send({ text: '/compact' });
  await vi.waitFor(() =>
    expect(c.calls.some((x) => x.method === 'thread/compact/start')).toBe(true),
  );
  c.event('turn/started', { turn: { id: 'compact-1' } });
  c.event('turn/completed', { turn: { id: 'compact-1', status: 'completed' } });
  await vi.waitFor(() => expect(session.status).toBe('idle'));
  const messages = h.codex.store.messages(session.sessionId);
  expect(messages.filter((m) => m.type === 'assistant')).toHaveLength(before);
  expect(messages.at(-1)).not.toHaveProperty('usage');
});

it('sends absolute paths as normal Codex prompts and rejects compact attachments', async () => {
  const h = harness();
  const session = h.create();
  const c = await h.running();
  c.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  session.send({ text: '/home/me/src/foo.ts has a bug' });
  await vi.waitFor(() => expect(c.calls.filter((x) => x.method === 'turn/start')).toHaveLength(2));
  c.event('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
  session.send({ text: '/compact', images: [{ mediaType: 'image/png', dataBase64: 'AA==' }] });
  await vi.waitFor(() => expect(session.status).toBe('idle'));
  expect(c.calls.filter((x) => x.method === 'turn/start')).toHaveLength(2);
  expect(c.calls.some((x) => x.method === 'thread/compact/start')).toBe(false);
});

it.each([{ config: undefined }, { config: [] }])(
  'fails closed before a Codex title turn with invalid configuration $config',
  async ({ config }) => {
    const h = harness({ 'config/read': { config } });
    await expect(
      h.adapter.oneShot({
        prompt: 'Title',
        systemPrompt: 'Title only',
        model: 'codex:default',
        cwd: dir,
        env: {},
        claudePath: '',
        sessionId: 'title-query',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('effective configuration');
    const c = h.connections.at(-1)!;
    expect(c.calls.some((x) => x.method === 'thread/start' || x.method === 'turn/start')).toBe(
      false,
    );
    expect(c.client.close).toHaveBeenCalled();
  },
);

it('closes a Codex title query on cancellation', async () => {
  const h = harness({ 'config/read': { config: {} } });
  const controller = new AbortController();
  const answer = h.adapter.oneShot({
    prompt: 'Title',
    systemPrompt: 'Title only',
    model: 'codex:default',
    cwd: dir,
    env: {},
    claudePath: '',
    sessionId: 'title-query',
    signal: controller.signal,
  });
  const rejected = expect(answer).rejects.toThrow('cancelled');
  await vi.waitFor(() =>
    expect(h.connections.at(-1)?.calls.some((x) => x.method === 'turn/start')).toBe(true),
  );
  controller.abort(new Error('cancelled'));
  await rejected;
  expect(h.connections.at(-1)!.client.close).toHaveBeenCalled();
});

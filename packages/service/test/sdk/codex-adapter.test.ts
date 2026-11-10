import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '@threadgarden/protocol';
import { LiveSession } from '../../src/chat/live-session.js';
import { Normalizer } from '../../src/chat/normalize.js';
import { CodexAdapter, codexPermissions } from '../../src/sdk/codex-adapter.js';
import type { CodexConnection, ConnectCodex } from '../../src/sdk/codex-client.js';
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
          return { thread: { id: 'thread-123' }, model: 'test-model' };
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

  it('consumes queued messages in one next turn and applies reasoning controls natively', async () => {
    const h = harness();
    const session = h.create();
    const connection = await h.running();
    await session.setEffort('high');
    expect(session.send({ text: 'second' })).toEqual({ queued: true });
    expect(session.send({ text: 'third' })).toEqual({ queued: true });
    expect(connection.calls.filter((c) => c.method === 'turn/start')).toHaveLength(1);
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() =>
      expect(connection.calls.filter((c) => c.method === 'turn/start')).toHaveLength(2),
    );
    expect(connection.calls.filter((c) => c.method === 'turn/start')[1]!.params).toMatchObject({
      effort: 'high',
      input: [
        { type: 'text', text: 'second' },
        { type: 'text', text: 'third' },
      ],
    });
    connection.event('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
    await expect(session.setEffort('max')).rejects.toThrow('does not support');
  });

  it('keeps messages sent during initialization queued behind the first turn', async () => {
    const h = harness();
    const session = h.create();
    expect(session.send({ text: 'arrived during startup' })).toEqual({ queued: true });
    const connection = await h.running();
    expect(connection.calls.find((call) => call.method === 'turn/start')?.params.input).toEqual([
      { type: 'text', text: 'hello', text_elements: [] },
    ]);
    connection.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await vi.waitFor(() =>
      expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2),
    );
    connection.event('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    await vi.waitFor(() => expect(session.status).toBe('idle'));
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

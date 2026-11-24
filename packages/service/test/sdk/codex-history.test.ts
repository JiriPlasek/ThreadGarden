import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexHistory } from '../../src/sdk/codex-history.js';
import { CodexStore } from '../../src/sdk/codex-store.js';
import {
  CodexNotFoundError,
  type CodexConnection,
  type ConnectCodex,
} from '../../src/sdk/codex-client.js';
import { Normalizer } from '../../src/chat/normalize.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OWN = 'codex-44444444-4444-4444-8444-444444444444';
type Rec = Record<string, unknown>;
let dir: string;
let histories: CodexHistory[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-codex-history-'));
  histories = [];
});
afterEach(() => {
  histories.forEach((history) => history.close());
  rmSync(dir, { recursive: true, force: true });
});
const thread = (id: string, extra: Rec = {}) => ({
  id,
  cwd: dir,
  name: `Thread ${id[0]}`,
  preview: 'first prompt',
  model: 'test-model',
  modelProvider: 'openai',
  createdAt: 100,
  updatedAt: 200,
  historyMode: 'paginated',
  status: { type: 'notLoaded' },
  ...extra,
});
const setup = (request: (method: string, params: Rec) => Promise<Rec> | Rec) => {
  const calls: { method: string; params: Rec }[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const connect: ConnectCodex = (env) => {
    envs.push(env);
    const client: CodexConnection = {
      request: async (method, params) => {
        calls.push({ method, params });
        return request(method, params);
      },
      notify: vi.fn(),
      reply: vi.fn(),
      reject: vi.fn(),
      close: vi.fn(),
    };
    return client;
  };
  const store = new CodexStore(dir);
  const history = new CodexHistory(store, () => ({ CODEX_HOME: '/current' }), connect, connect);
  histories.push(history);
  return { store, history, calls, envs };
};

describe('native Codex history', () => {
  it('rejects an unfinished turn before attempting a native fork', async () => {
    const h = setup((method) => {
      if (method === 'thread/read') return { thread: thread(A) };
      if (method === 'thread/turns/list')
        return {
          data: [
            {
              id: 'busy',
              status: 'inProgress',
              items: [
                { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
              ],
            },
          ],
        };
      return {};
    });
    h.store.save({ id: OWN, threadId: A, cwd: dir, createdAt: 1, updatedAt: 2 });
    await expect(h.history.fork(OWN, { upToMessageId: 'prompt' })).rejects.toThrow(
      'completed Codex turn',
    );
    expect(h.calls.some((call) => call.method === 'thread/fork')).toBe(false);
  });

  it.each([A, 'bad-id'])(
    'does not save a fork when Codex returns invalid new thread id %s',
    async (id) => {
      const h = setup((method) => (method === 'thread/fork' ? { thread: thread(id) } : {}));
      h.store.save({ id: OWN, threadId: A, cwd: dir, createdAt: 1, updatedAt: 2 });
      await expect(h.history.fork(OWN, {})).rejects.toThrow();
      expect(h.store.records().map((record) => record.id)).toEqual([OWN]);
    },
  );

  it('forks through a completed turn in its original home without changing the source', async () => {
    const h = setup((method) => {
      if (method === 'thread/read') return { thread: thread(A) };
      if (method === 'thread/turns/list')
        return {
          data: [
            {
              id: 'turn1',
              status: 'completed',
              items: [
                { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                { id: 'answer', type: 'agentMessage', text: 'hello back' },
              ],
            },
          ],
          nextCursor: null,
        };
      if (method === 'thread/fork') return { thread: thread(B) };
      return {};
    });
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      native: true,
      home: '/original',
      modelProvider: 'custom',
      model: 'codex:test-model',
      createdAt: 1,
      updatedAt: 2,
    });
    await expect(h.history.fork(OWN, { upToMessageId: 'missing' })).rejects.toThrow(
      'message in a completed Codex turn',
    );
    expect(h.calls.some((c) => c.method === 'thread/fork')).toBe(false);
    await expect(h.history.fork(OWN, { upToMessageId: 'prompt' })).resolves.toEqual({
      sessionId: `codex-${B}`,
    });
    expect(h.calls.find((c) => c.method === 'thread/fork')?.params).toEqual({
      threadId: A,
      modelProvider: 'custom',
      model: 'test-model',
      lastTurnId: 'turn1',
      excludeTurns: true,
    });
    expect(h.store.read(`codex-${B}`)).toMatchObject({
      threadId: B,
      home: '/original',
      preservePermissions: true,
      modelProvider: 'openai',
    });
    expect(h.store.read(OWN)?.threadId).toBe(A);
    expect(h.envs.every((env) => env.CODEX_HOME === '/original')).toBe(true);
  });

  it('imports every page including archives, excludes child threads, and keeps existing Threadgarden ids', async () => {
    const h = setup((method, p) =>
      method === 'thread/list'
        ? p.archived
          ? { data: [thread(C)], nextCursor: null }
          : p.cursor
            ? { data: [thread(B)], nextCursor: null }
            : { data: [thread(A), thread(C, { parentThreadId: A })], nextCursor: 'page2' }
        : {},
    );
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      createdAt: 100000,
      updatedAt: 200000,
      firstPrompt: 'own',
    });
    const list = await h.history.list();
    expect(list.map((info) => info.sessionId)).toEqual([OWN, `codex-${B}`, `codex-${C}`]);
    expect(list.find((info) => info.sessionId === OWN)).toMatchObject({
      cwd: dir,
      customTitle: 'Thread 1',
      createdAt: 100000,
      lastModified: 200000,
    });
    expect(h.calls.filter((call) => call.method === 'thread/list')).toHaveLength(3);
    expect(
      h.calls
        .filter((call) => call.method === 'thread/list')
        .every((call) => call.params.useStateDbOnly === true),
    ).toBe(true);
    expect(h.calls.some((call) => /thread\/(start|resume|archive|delete)/.test(call.method))).toBe(
      false,
    );
  });

  it('normalizes paginated turns, images, reasoning, plans, tool errors and results without resuming', async () => {
    const h = setup((method, p) => {
      if (method === 'thread/list')
        return { data: p.archived ? [] : [thread(A)], nextCursor: null };
      if (method === 'thread/read') return { thread: thread(A) };
      if (method === 'thread/turns/list')
        return p.cursor
          ? {
              data: [
                {
                  id: 'turn2',
                  status: 'completed',
                  startedAt: 102,
                  completedAt: 103,
                  items: [
                    { id: 'plan', type: 'plan', text: 'A plan' },
                    { id: 'compact', type: 'contextCompaction' },
                  ],
                },
              ],
              nextCursor: null,
            }
          : {
              data: [
                {
                  id: 'turn1',
                  status: 'completed',
                  startedAt: 100,
                  completedAt: 101,
                  items: [
                    {
                      id: 'native-user',
                      clientId: 'user-id',
                      type: 'userMessage',
                      content: [
                        { type: 'text', text: 'hello' },
                        { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
                      ],
                    },
                    { id: 'thought', type: 'reasoning', summary: ['Summary'] },
                    {
                      id: 'tool',
                      type: 'commandExecution',
                      command: 'pwd',
                      status: 'failed',
                      aggregatedOutput: 'denied',
                    },
                    { id: 'reply', type: 'agentMessage', text: 'Done' },
                  ],
                },
              ],
              nextCursor: 'next',
            };
      return {};
    });
    await h.history.list();
    const messages = await h.history.messages(`codex-${A}`);
    const normalizer = new Normalizer();
    const items = new Map();
    for (const message of messages)
      for (const item of normalizer.push(message).items) items.set(item.id, item);
    expect(items.get('user-id')).toMatchObject({
      kind: 'user',
      text: 'hello',
      images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
    });
    expect(items.get('thought')).toMatchObject({ kind: 'thinking', text: 'Summary' });
    expect(items.get('tool')).toMatchObject({
      kind: 'toolCall',
      status: 'error',
      resultText: 'denied',
    });
    expect(items.get('reply')).toMatchObject({ kind: 'assistantText', markdown: 'Done' });
    expect(items.get('plan')).toMatchObject({ kind: 'assistantText', markdown: 'A plan' });
    expect(items.get('compact')).toMatchObject({ kind: 'compactBoundary' });
    expect(h.calls.some((call) => call.method === 'thread/resume')).toBe(false);
  });

  it('reads legacy history and retains journal user UUIDs without duplicate replies', async () => {
    const h = setup((method, p) => {
      if (method === 'thread/list')
        return { data: p.archived ? [] : [thread(A, { historyMode: 'legacy' })], nextCursor: null };
      if (method === 'thread/read')
        return {
          thread: thread(A, {
            historyMode: 'legacy',
            turns: p.includeTurns
              ? [
                  {
                    id: 'turn1',
                    status: 'completed',
                    items: [
                      {
                        id: 'native-user',
                        clientId: 'own-user',
                        type: 'userMessage',
                        content: [{ type: 'text', text: 'hello' }],
                      },
                      { id: 'reply', type: 'agentMessage', text: 'Done' },
                    ],
                  },
                ]
              : [],
          }),
        };
      return {};
    });
    h.store.save({ id: OWN, threadId: A, cwd: dir, createdAt: 100000, updatedAt: 200000 });
    h.store.append(h.store.read(OWN)!, {
      type: 'user',
      uuid: 'own-user',
      message: { role: 'user', content: 'hello' },
    } as never);
    await h.history.list();
    const messages = await h.history.messages(OWN);
    expect(messages.filter((message) => message.uuid === 'own-user')).toHaveLength(1);
    expect(messages.filter((message) => message.uuid === 'reply')).toHaveLength(1);
    expect(h.calls.some((call) => call.method === 'thread/turns/list')).toBe(false);
  });

  it('shows each queued message once when one turn took several of them', async () => {
    const h = setup((method, p) => {
      if (method === 'thread/list')
        return { data: p.archived ? [] : [thread(A, { historyMode: 'legacy' })], nextCursor: null };
      if (method === 'thread/read')
        return {
          thread: thread(A, {
            historyMode: 'legacy',
            turns: p.includeTurns
              ? [
                  {
                    id: 'turn1',
                    status: 'completed',
                    items: [
                      {
                        id: 'native-user',
                        clientId: 'u1',
                        type: 'userMessage',
                        startedAtMs: 150000,
                        content: [
                          { type: 'text', text: 'first' },
                          { type: 'text', text: 'second' },
                          { type: 'text', text: 'third' },
                        ],
                      },
                      { id: 'reply', type: 'agentMessage', text: 'Done', startedAtMs: 160000 },
                    ],
                  },
                ]
              : [],
          }),
        };
      return {};
    });
    h.store.save({ id: OWN, threadId: A, cwd: dir, createdAt: 100000, updatedAt: 200000 });
    for (const [uuid, text] of [
      ['u1', 'first'],
      ['u2', 'second'],
      ['u3', 'third'],
    ] as const)
      h.store.append(h.store.read(OWN)!, {
        type: 'user',
        uuid,
        timestamp: new Date(150000).toISOString(),
        message: { role: 'user', content: text },
      } as never);
    await h.history.list();
    const texts = (await h.history.messages(OWN))
      .filter((message) => message.type === 'user')
      .flatMap((message) => {
        const content = (message as unknown as { message: { content: unknown } }).message.content;
        return typeof content === 'string'
          ? [content]
          : (content as { text: string }[]).map((block) => block.text);
      });
    expect(texts).toEqual(['first', 'second', 'third']);
  });

  it('uses the saved Codex home when the current discovery folder changes', async () => {
    const h = setup((method) =>
      method === 'thread/read' ? { thread: thread(A) } : { data: [], nextCursor: null },
    );
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      home: '/original',
      native: true,
      historyMode: 'paginated',
      createdAt: 100000,
      updatedAt: 200000,
    });
    await h.history.messages(OWN);
    expect(h.envs[0]!.CODEX_HOME).toBe('/original');
    expect(h.store.read(OWN)?.home).toBe('/original');
  });

  it('detects loaded external threads, maps waiting states, and never resumes them', async () => {
    const h = setup((method, p) =>
      method === 'thread/loaded/list'
        ? { data: p.cursor ? [B] : [A], nextCursor: p.cursor ? null : 'more' }
        : method === 'thread/read'
          ? {
              thread: thread(String(p.threadId), {
                status:
                  p.threadId === A
                    ? { type: 'active', activeFlags: ['waitingOnApproval'] }
                    : { type: 'idle' },
              }),
            }
          : {},
    );
    const sessions = await h.history.external();
    expect(sessions.map((session) => session.sessionId)).toEqual([`codex-${A}`, `codex-${B}`]);
    expect(sessions[0]).toMatchObject({
      kind: 'codex',
      status: 'waiting',
      waitingFor: 'Approve a Codex action',
    });
    expect(sessions[1]?.status).toBe('idle');
    expect(h.calls.some((call) => call.method === 'thread/resume')).toBe(false);
  });

  it('rejects repeated cursors instead of hanging an index pass', async () => {
    const h = setup(() => ({ data: [thread(A)], nextCursor: 'same' }));
    await expect(h.history.list()).rejects.toThrow('repeated a history cursor');
  });

  it('lists the chats it knows, with no problem, when the Codex CLI is not installed', async () => {
    const store = new CodexStore(dir);
    const missing: ConnectCodex = () => {
      throw new CodexNotFoundError();
    };
    const history = new CodexHistory(store, () => ({}), missing, missing);
    histories.push(history);
    store.save({ id: OWN, threadId: A, cwd: dir, native: true, createdAt: 1, updatedAt: 2 });
    const list = await history.list();
    expect(list.map((info) => info.sessionId)).toEqual([OWN]);
    expect(history.historyProblem).toBeUndefined();
  });

  it('still reports a Codex CLI that is installed but broken', async () => {
    const store = new CodexStore(dir);
    const broken: ConnectCodex = () => {
      throw new Error('spawn EACCES');
    };
    const history = new CodexHistory(store, () => ({}), broken, broken);
    histories.push(history);
    await expect(history.list()).rejects.toThrow('EACCES');
    expect(history.historyProblem).toContain('EACCES');
  });

  it('keeps chats imported from an earlier Codex home in the list', async () => {
    const h = setup(() => ({ data: [], nextCursor: null }));
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      home: '/original',
      native: true,
      createdAt: 1,
      updatedAt: 2,
    });
    h.store.save({
      id: `codex-${B}`,
      threadId: B,
      cwd: dir,
      home: '/current',
      native: true,
      createdAt: 1,
      updatedAt: 2,
    });
    const list = await h.history.list();
    // B was in the current home and Codex no longer lists it: it is gone.
    expect(list.map((info) => info.sessionId)).toEqual([OWN]);
  });

  it('does not undo a model or effort picked in a live chat when the history is polled', async () => {
    const h = setup(() => ({
      data: [thread(A, { reasoningEffort: 'low' })],
      nextCursor: null,
    }));
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      native: true,
      model: 'codex:test-model',
      effort: 'low',
      createdAt: 100000,
      updatedAt: 200000,
    });
    // A live session holds the record object the store keeps for its thread.
    const live = h.store.recordForThread(A)!;
    live.model = 'codex:picked';
    live.effort = 'high';
    h.store.save(live);
    await h.history.list();
    expect(live).toMatchObject({ model: 'codex:picked', effort: 'high' });
    expect(h.store.read(OWN)).toMatchObject({ model: 'codex:picked', effort: 'high' });
  });

  it('follows a model changed in Codex itself after the chat was last used here', async () => {
    const h = setup(() => ({
      data: [thread(A, { updatedAt: 300, model: 'other-model', reasoningEffort: 'medium' })],
      nextCursor: null,
    }));
    h.store.save({
      id: OWN,
      threadId: A,
      cwd: dir,
      native: true,
      model: 'codex:test-model',
      effort: 'low',
      createdAt: 100000,
      updatedAt: 200000,
    });
    await h.history.list();
    expect(h.store.read(OWN)).toMatchObject({ model: 'codex:other-model', effort: 'medium' });
  });

  it('polls external threads over one connection and writes only records that changed', async () => {
    const h = setup((method, p) =>
      method === 'thread/loaded/list'
        ? { data: [A], nextCursor: null }
        : method === 'thread/read'
          ? { thread: thread(String(p.threadId), { status: { type: 'idle' } }) }
          : {},
    );
    await h.history.external();
    const save = vi.spyOn(h.store, 'save');
    await h.history.external();
    await h.history.external();
    expect(h.envs).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('shares one external pass between overlapping callers', async () => {
    const h = setup((method, p) =>
      method === 'thread/loaded/list'
        ? { data: [A], nextCursor: null }
        : method === 'thread/read'
          ? { thread: thread(String(p.threadId), { status: { type: 'idle' } }) }
          : {},
    );
    const [first, second] = await Promise.all([h.history.external(), h.history.external()]);
    expect(second).toEqual(first);
    expect(h.calls.filter((call) => call.method === 'thread/loaded/list')).toHaveLength(1);
  });
});

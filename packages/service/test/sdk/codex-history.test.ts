import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexHistory } from '../../src/sdk/codex-history.js';
import { CodexStore } from '../../src/sdk/codex-store.js';
import type { CodexConnection, ConnectCodex } from '../../src/sdk/codex-client.js';
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
});

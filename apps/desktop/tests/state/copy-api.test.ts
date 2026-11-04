import {
  AWAY_ERROR,
  type ChatCopy,
  type ChatSummary,
  type MachineCopy,
  type Project,
} from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../../src/lib/service/client';
import type { Api } from '../../src/lib/state/api';
import { copiedAtOf, copyApi } from '../../src/lib/state/copy-api';
import { M1, machineInfo, project, summary } from '../layout/harness';
import { text, user } from '../chat/fixtures';

type Handler = (params: never) => unknown;

/** The local service: what it answers by method, and what it was asked. */
const fakeLocal = (handlers: Record<string, Handler>) => {
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`no handler for ${method}`);
      return h(params as never);
    }),
  };
  return { api: api as unknown as Pick<Api, 'request'>, calls };
};

const COPIED_AT = 1_700_000_000_000;

/** A project as a copy keeps it (`exists` always set). */
const copied = (...a: Parameters<typeof project>): Project => ({ ...project(...a), exists: true });

const chats: ChatSummary[] = [
  summary('waiting', { status: 'needsYou', lastActivity: 10 }),
  summary('working', { status: 'working', lastActivity: 50 }),
  summary('old', { lastActivity: 20 }),
  summary('new', { lastActivity: 90, title: 'Deploy the site' }),
  summary('unread', { lastActivity: 70, unread: true }),
  summary('held', { lastActivity: 80, bucket: 'onHold' }),
  summary('gone', { lastActivity: 85, bucket: 'archived' }),
  summary('other', { lastActivity: 95, projectId: 'p2' }),
  summary('hidden', { lastActivity: 99, projectId: 'p3' }),
];

const machineCopy = (over: Partial<MachineCopy> = {}): MachineCopy => ({
  machineId: M1,
  info: machineInfo(M1, 'ubuntu-pc', ['remote', 'away']),
  projects: [copied('p1', 'alpha'), copied('p2', 'beta'), copied('p3', 'gamma', { hidden: true })],
  chats,
  copiedAt: COPIED_AT,
  ...over,
});

const chatCopy: ChatCopy = {
  machineId: M1,
  sessionId: 'old',
  summary: summary('old', { lastActivity: 20 }),
  items: [user('u1', 'Why is CI red?'), text('a1', 'The lockfile is stale.')],
  copiedAt: COPIED_AT,
};

const setup = (o: { copy?: MachineCopy | null } = {}) => {
  const local = fakeLocal({
    'copies.get': () => (o.copy === undefined ? machineCopy() : o.copy),
    'copies.chat': ((p: { sessionId: string }) =>
      p.sessionId === chatCopy.sessionId ? chatCopy : null) as Handler,
    'away.queue': ((p: { sessionId: string; kind: 'send' | 'create'; text: string }) => ({
      id: 'row-1',
      machineId: M1,
      sessionId: p.sessionId,
      kind: p.kind,
      text: p.text,
      imageCount: 0,
      cwd: null,
      createdAt: 1,
      state: 'waiting',
      reason: null,
      error: null,
    })) as Handler,
  });
  const seen = vi.fn();
  const api = copyApi(M1, local.api, { name: () => 'Ubuntu PC', seen });
  return { api, local, seen };
};

const ids = (items: ChatSummary[]): string[] => items.map((c) => c.sessionId);

describe('the copy API of a machine that is away', () => {
  it('answers the counts, the projects and the lists from the copy', async () => {
    const { api, local, seen } = setup();
    expect(await api.request('places.counts', {})).toEqual({
      needsYou: 2,
      running: 1,
      all: 6,
      active: 6,
      onHold: 1,
      archived: 1,
    });
    expect((await api.request('projects.list', {})).map((p) => p.projectId)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    // Needs you: the chats waiting on the user first, then the unread ones.
    const needsYou = await api.request('sessions.list', { place: { kind: 'needsYou' }, limit: 50 });
    expect(ids(needsYou.items)).toEqual(['waiting', 'unread']);
    const running = await api.request('sessions.list', { place: { kind: 'running' }, limit: 50 });
    expect(ids(running.items)).toEqual(['working']);
    // A bucket in the service's order, paged; a hidden project's chats are left out.
    const first = await api.request('sessions.list', { place: { kind: 'active' }, limit: 3 });
    expect(ids(first.items)).toEqual(['waiting', 'working', 'other']);
    expect(first.nextCursor).toBeDefined();
    const second = await api.request('sessions.list', {
      place: { kind: 'active' },
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(ids(second.items)).toEqual(['new', 'unread', 'old']);
    expect(second.nextCursor).toBeUndefined();
    const project = await api.request('sessions.list', {
      place: { kind: 'project', projectId: 'p1', include: ['onHold'] },
      limit: 50,
    });
    expect(ids(project.items)).toEqual(['waiting', 'working', 'new', 'held', 'unread', 'old']);
    const found = await api.request('sessions.list', {
      place: { kind: 'active' },
      limit: 50,
      query: 'deploy',
    });
    expect(ids(found.items)).toEqual(['new']);
    expect(
      (await api.request('sessions.summaries', { sessionIds: ['old', 'nope'] })).items,
    ).toEqual([chats[2]]);
    // Only the local service was asked, and each read was reported.
    expect(new Set(local.calls.map((c) => c.method))).toEqual(new Set(['copies.get']));
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({ machineId: M1, copiedAt: COPIED_AT }),
    );
  });

  it('opens a chat from its copy, marked with when it was copied', async () => {
    const { api } = setup();
    const opened = await api.request('chat.open', { sessionId: 'old', tail: 200 });
    expect(opened.items).toEqual(chatCopy.items);
    expect(opened.summary).toEqual(chats[2]);
    expect(opened.hasMore).toBe(false);
    expect(opened.tasks).toEqual([]);
    expect(copiedAtOf(opened)).toBe(COPIED_AT);
    // A chat with no tail of its own yet opens with its summary and no messages.
    const bare = await api.request('chat.open', { sessionId: 'new', tail: 200 });
    expect(bare.items).toEqual([]);
    expect(bare.summary.title).toBe('Deploy the site');
    expect(copiedAtOf(bare)).toBe(COPIED_AT);
  });

  it('has nothing older to load, and lets any chat be resumed', async () => {
    const { api } = setup();
    expect(
      await api.request('chat.older', { sessionId: 'old', beforeItemId: 'u1', limit: 200 }),
    ).toEqual({ items: [], hasMore: false });
    expect(await api.request('chat.resumeCheck', { sessionId: 'old' })).toEqual({
      status: 'ok',
      reason: '',
      recentlyModified: false,
    });
  });

  it('queues a message for a chat, and a new chat under the id it was given', async () => {
    const { api, local } = setup();
    expect(await api.request('chat.send', { sessionId: 'old', text: 'Postgres' })).toEqual({
      queued: false,
    });
    const sessionId = '6f1c1e7e-8a3b-4c55-9e2f-0d9a1b2c3d4e';
    expect(
      await api.request('chat.create', {
        cwd: '/work/alpha',
        text: 'Start here',
        model: 'opus',
        sessionId,
      }),
    ).toEqual({ sessionId });
    const queued = local.calls.filter((c) => c.method === 'away.queue').map((c) => c.params);
    expect(queued).toEqual([
      { machineId: M1, sessionId: 'old', kind: 'send', text: 'Postgres' },
      {
        machineId: M1,
        sessionId,
        kind: 'create',
        text: 'Start here',
        cwd: '/work/alpha',
        model: 'opus',
      },
    ]);
  });

  it('refuses anything else, and every list when there is no copy: ‹machine› is off', async () => {
    const refused = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RequestError);
      expect(err).toMatchObject({ code: AWAY_ERROR, message: 'Ubuntu PC is off' });
    };
    const { api, local } = setup();
    await refused(api.request('chat.interrupt', { sessionId: 'old' }));
    await refused(
      api.request('chat.respond', { sessionId: 'old', requestId: 'r', decision: 'allow' }),
    );
    await refused(api.request('chat.open', { sessionId: 'unknown', tail: 200 }));
    expect(local.calls.filter((c) => c.method === 'away.queue')).toHaveLength(0);

    const none = setup({ copy: null });
    await refused(none.api.request('projects.list', {}));
    await refused(none.api.request('places.counts', {}));
    await refused(none.api.request('sessions.list', { place: { kind: 'active' }, limit: 5 }));
    expect(none.seen).toHaveBeenLastCalledWith(null);
  });
});

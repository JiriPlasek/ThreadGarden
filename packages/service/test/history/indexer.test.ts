import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { Indexer, extractText, MAX_TEXT_CHARS } from '../../src/history/indexer.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';

const setup = (sessions = 45) => {
  const adapter = generateCorpus({ sessions, projects: 3, bigSessionMessages: 0 });
  const db = openDb(':memory:');
  const events: { event: string; data: unknown }[] = [];
  const indexer = new Indexer(adapter, db, (e) => events.push(e), {
    platform: 'linux',
    gitCommonDir: () => null,
  });
  return { adapter, db, events, indexer };
};

const sm = (type: string, message: unknown): SessionMessage =>
  ({ type, uuid: 'u', session_id: 's', message, parent_tool_use_id: null }) as SessionMessage;

describe('extractText', () => {
  it('takes user strings and assistant text blocks, skipping tool results and thinking', () => {
    const text = extractText([
      sm('user', { role: 'user', content: 'hello there' }),
      sm('assistant', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', id: 't', name: 'X', input: { q: 'toolinput' } },
        ],
      }),
      sm('user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'toolresult' }],
      }),
      sm('system', { content: 'ignored' }),
    ]);
    expect(text).toContain('hello there');
    expect(text).toContain('visible answer');
    expect(text).not.toMatch(/secret|toolinput|toolresult|ignored/);
  });

  it('is robust to odd shapes', () => {
    expect(extractText([sm('user', null), sm('assistant', 5), sm('user', { content: 7 })])).toBe(
      '',
    );
    expect(MAX_TEXT_CHARS).toBe(2 * 1024 * 1024);
  });
});

describe('Indexer', () => {
  it('fullSync indexes all sessions and emits progress', async () => {
    const { db, events, indexer, adapter } = setup();
    await indexer.fullSync();
    expect(db.listSessions({}, 1000, undefined).items).toHaveLength(45);
    for (const s of adapter.sessions.values()) expect(db.needsReindex(s.info)).toBe(false);
    const progress = events
      .filter((e) => e.event === 'index.progress')
      .map((e) => e.data as { done: number; total: number });
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toEqual({ done: 45, total: 45 });
    expect(events.some((e) => e.event === 'sessions.changed')).toBe(true);
    expect(db.searchFts('parity', 1000).length).toBeGreaterThan(0);
    const projects = db.listProjects();
    expect(projects).toHaveLength(3);
    expect(projects.every((p) => p.displayName.length > 0)).toBe(true);
  });

  it('refresh only reindexes changed sessions', async () => {
    const { adapter, db, indexer, events } = setup(5);
    await indexer.fullSync();
    const spy = vi.spyOn(adapter, 'getSessionMessages');
    events.length = 0;

    await indexer.refresh([...adapter.sessions.keys()]);
    expect(spy).not.toHaveBeenCalled();

    const [id] = [...adapter.sessions.keys()];
    const s = adapter.sessions.get(id as string)!;
    s.info = {
      ...s.info,
      lastModified: s.info.lastModified + 1000,
      fileSize: (s.info.fileSize ?? 0) + 5,
    };
    s.messages.push(sm('user', { role: 'user', content: 'zebrafish appended' }));
    await indexer.refresh([id as string]);
    expect(spy.mock.calls.every((c) => c[0] === id)).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(db.searchFts('zebrafish', 5).map((h) => h.sessionId)).toEqual([id]);
    expect(events).toContainEqual({ event: 'sessions.changed', data: { sessionIds: [id] } });
  });

  it('caps indexed text per session', async () => {
    const adapter = generateCorpus({ sessions: 0, projects: 1, bigSessionMessages: 500 });
    const db = openDb(':memory:');
    const indexer = new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
      maxTextChars: 50_000,
    });
    await indexer.fullSync();
    const rows = db.raw.prepare('SELECT sum(length(text)) AS n FROM messages_fts').get() as {
      n: number;
    };
    expect(rows.n).toBeLessThanOrEqual(50_000 + 20_000);
    expect(rows.n).toBeGreaterThan(10_000);
  });
});

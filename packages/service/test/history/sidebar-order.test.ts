import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { Catalog, type LiveChat } from '../../src/history/catalog.js';

const setup = () => {
  const db = openDb(':memory:');
  let live: LiveChat[] = [];
  for (const [id, at] of [
    ['a', 100],
    ['b', 200],
    ['c', 300],
  ] as const) {
    db.upsertProject({ projectId: id, path: '/' + id, displayName: id });
    db.upsertSession(
      { sessionId: id, cwd: '/' + id, summary: 'find ' + id, lastModified: at, createdAt: 1 },
      id,
    );
    db.recordUserMessage(id, at);
  }
  const catalog = new Catalog({
    db,
    live: { list: () => live },
    externals: () => [],
    platform: 'linux',
    gitCommonDir: () => null,
  });
  const ids = (query?: string) =>
    catalog.list({ kind: 'active' }, query, 20).items.map((s) => s.sessionId);
  return {
    db,
    catalog,
    ids,
    setLive: (next: LiveChat[]) => {
      live = next;
    },
  };
};

describe('stable sidebar ordering', () => {
  it('keeps chat and project order stable through assistant activity and status changes', () => {
    const t = setup();
    const original = t.ids();
    expect(original).toEqual(['c', 'b', 'a']);
    t.setLive([{ sessionId: 'a', cwd: '/a', status: 'working', live: true, lastActivity: 900 }]);
    t.db.upsertSession({ sessionId: 'a', cwd: '/a', summary: 'find a', lastModified: 900 }, 'a');
    t.catalog.invalidate();
    expect(t.ids()).toEqual(original);
    expect(t.catalog.projects().map((p) => p.projectId)).toEqual(['c', 'b', 'a']);
    expect(t.catalog.summary('a')?.lastActivity).toBe(900);
    expect(t.catalog.summary('a')?.sortAt).toBe(100);
    t.setLive([{ sessionId: 'a', cwd: '/a', status: 'idle', live: true, lastActivity: 1000 }]);
    expect(t.ids('find')).toEqual(original);
  });

  it('moves chats and projects on user input or handoff, and not on later output', () => {
    const t = setup();
    t.db.recordUserMessage('a', 400);
    t.catalog.invalidate();
    expect(t.ids()).toEqual(['a', 'c', 'b']);
    t.db.setTurnEnded('b', 500);
    t.catalog.invalidate();
    expect(t.ids()).toEqual(['b', 'a', 'c']);
    expect(t.catalog.projects().map((p) => p.projectId)).toEqual(['b', 'a', 'c']);
    t.db.markSeen('b', 510);
    t.catalog.invalidate();
    expect(t.ids()).toEqual(['a', 'c', 'b']);
    t.db.recordNeedsYou('c', 600);
    t.setLive([{ sessionId: 'c', cwd: '/c', status: 'needsYou', live: true, lastActivity: 900 }]);
    expect(t.ids()).toEqual(['c', 'a', 'b']);
    expect(t.catalog.summary('c')?.sortAt).toBe(600);
  });

  it.each(['answered', 'ended', 'seen'])(
    'does not duplicate a handoff row across pages when it is %s',
    (change) => {
      const t = setup();
      if (change === 'seen') t.db.setTurnEnded('a', 500);
      else {
        t.db.recordNeedsYou('a', 500);
        t.setLive([{ sessionId: 'a', cwd: '/a', status: 'needsYou', live: true }]);
      }
      t.catalog.invalidate();
      const first = t.catalog.list({ kind: 'active' }, undefined, 2);
      expect(first.items.map((s) => s.sessionId)).toEqual(['a', 'c']);
      if (change === 'seen') t.db.markSeen('a', 510);
      else
        t.setLive(
          change === 'ended' ? [] : [{ sessionId: 'a', cwd: '/a', status: 'working', live: true }],
        );
      t.catalog.invalidate();
      const second = t.catalog.list({ kind: 'active' }, undefined, 2, first.nextCursor);
      expect(second.items.map((s) => s.sessionId)).toEqual(['b']);
      expect(second.nextCursor).toBeUndefined();
    },
  );

  it('paginates live/history together without gaps when a live overlay ends', () => {
    const t = setup();
    t.setLive([{ sessionId: 'b', cwd: '/b', status: 'working', live: true, lastActivity: 1000 }]);
    const first = t.catalog.list({ kind: 'active' }, undefined, 1);
    expect(first.items.map((s) => s.sessionId)).toEqual(['c']);
    t.setLive([]);
    const second = t.catalog.list({ kind: 'active' }, undefined, 1, first.nextCursor);
    const third = t.catalog.list({ kind: 'active' }, undefined, 1, second.nextCursor);
    expect([...first.items, ...second.items, ...third.items].map((s) => s.sessionId)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(third.nextCursor).toBeUndefined();
  });
});

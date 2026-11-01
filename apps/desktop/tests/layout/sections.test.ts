import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  groupChats,
  isNow,
  recencySection,
  type ListRow,
} from '../../src/lib/components/layout/sections';
import { summary } from './harness';

/** A fixed clock: grouping never reads the real time. */
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const ago = (ms: number): number => NOW - ms;

/** "header:Label(count)" and session ids, in display order. */
const shape = (rows: readonly ListRow[]): string[] =>
  rows.map((r) =>
    r.kind === 'header' ? `${r.label} (${r.count}${r.more ? '+' : ''})` : r.chat.sessionId,
  );

describe('recency sections (v1.2 §2)', () => {
  it('puts the boundaries in the newer section: exactly 1 h, 24 h, 7 d and 30 d', () => {
    expect(recencySection(NOW, NOW)).toBe('hour');
    expect(recencySection(ago(HOUR_MS), NOW)).toBe('hour');
    expect(recencySection(ago(HOUR_MS + 1), NOW)).toBe('day');
    expect(recencySection(ago(DAY_MS), NOW)).toBe('day');
    expect(recencySection(ago(DAY_MS + 1), NOW)).toBe('week');
    expect(recencySection(ago(7 * DAY_MS), NOW)).toBe('week');
    expect(recencySection(ago(7 * DAY_MS + 1), NOW)).toBe('month');
    expect(recencySection(ago(30 * DAY_MS), NOW)).toBe('month');
    expect(recencySection(ago(30 * DAY_MS + 1), NOW)).toBe('older');
  });

  it('reads clock skew as recent and a missing timestamp as older', () => {
    expect(recencySection(NOW + 60_000, NOW)).toBe('hour');
    expect(recencySection(0, NOW)).toBe('older');
    expect(recencySection(Number.NaN, NOW)).toBe('older');
  });

  it('needs-you, your-turn, working and running chats belong at the top', () => {
    expect(isNow(summary('a', { status: 'needsYou' }))).toBe(true);
    expect(isNow(summary('a', { status: 'working' }))).toBe(true);
    expect(isNow(summary('a', { status: 'idle', live: true, unread: true }))).toBe(true);
    const external = { kind: 'interactive', pid: 1 };
    expect(isNow(summary('a', { status: 'idle', external, unread: true }))).toBe(true);
    // Ruling R29: background tasks running in an idle chat count as Running.
    expect(isNow(summary('a', { status: 'idle', runningTasks: 2 }))).toBe(true);
    expect(isNow(summary('a', { status: 'idle' }))).toBe(false);
    expect(isNow(summary('a', { status: 'paused' }))).toBe(false);
    expect(isNow(summary('a', { status: 'history' }))).toBe(false);
    // An unread history row keeps its recency section: the service lists it at
    // its recency position, so a later page never moves it to the top.
    expect(isNow(summary('a', { status: 'history', unread: true }))).toBe(false);
    expect(isNow(summary('a', { status: 'idle', unread: true }))).toBe(false);
    // Forward compatibility: a status from a newer service goes by its recency.
    expect(isNow(summary('a', { status: 'sleeping' as never }))).toBe(false);
  });
});

describe('groupChats', () => {
  it('lists the last hour first, with the chats that need the user or run, then by recency', () => {
    const items = [
      summary('n1', { status: 'needsYou', lastActivity: ago(40 * DAY_MS) }),
      summary('w1', { status: 'working', lastActivity: ago(1000) }),
      summary('i1', { status: 'idle', live: true, lastActivity: ago(3 * DAY_MS) }),
      summary('h1', { lastActivity: ago(60_000) }),
      summary('u1', { status: 'idle', live: true, unread: true, lastActivity: ago(2 * 60_000) }),
      summary('d1', { lastActivity: ago(5 * HOUR_MS) }),
      summary('h2', { lastActivity: ago(2 * DAY_MS) }),
      summary('h3', { lastActivity: ago(20 * DAY_MS) }),
      summary('h4', { lastActivity: ago(400 * DAY_MS) }),
    ];
    const g = groupChats(items, NOW);
    expect(shape(g.rows)).toEqual([
      'Last hour (4)',
      'n1',
      'w1',
      'h1',
      'u1',
      'Last 24 hours (1)',
      'd1',
      'Last 7 days (2)',
      'i1',
      'h2',
      'Last 30 days (1)',
      'h3',
      'Older (1)',
      'h4',
    ]);
    // Chats in display order, each pointing at its row; the index answers lookups by id.
    expect(g.chats.map((c) => c.sessionId)).toEqual([
      'n1',
      'w1',
      'h1',
      'u1',
      'd1',
      'i1',
      'h2',
      'h3',
      'h4',
    ]);
    g.chats.forEach((c, i) => {
      const row = g.rows[g.rowOf[i]!]!;
      expect(row.kind === 'chat' && row.chat).toBe(c);
      expect(g.indexOf.get(c.sessionId)).toBe(i);
    });
  });

  it('hides empty sections', () => {
    const g = groupChats(
      [summary('h1', { lastActivity: ago(60_000) }), summary('h2', { lastActivity: ago(0) })],
      NOW,
    );
    expect(shape(g.rows)).toEqual(['Last hour (2)', 'h1', 'h2']);
    expect(groupChats([], NOW).rows).toEqual([]);
  });

  it('every chat of the Needs you and Running places belongs to "now"', () => {
    const items = [
      summary('n1', { status: 'needsYou' }),
      // Raced: the service listed it as needing the user, the status since moved on.
      summary('x1', { status: 'idle', lastActivity: ago(9 * DAY_MS) }),
    ];
    expect(shape(groupChats(items, NOW, { allNow: true }).rows)).toEqual(['Now (2)', 'n1', 'x1']);
  });

  it('marks the last section as partial while more pages are to come', () => {
    const page = [
      summary('h1', { lastActivity: ago(60_000) }),
      summary('h2', { lastActivity: ago(40 * DAY_MS) }),
    ];
    expect(shape(groupChats(page, NOW, { hasMore: true }).rows)).toEqual([
      'Last hour (1)',
      'h1',
      'Older (1+)',
      'h2',
    ]);
  });

  it('appending a page keeps every chat in the right section', () => {
    const page1 = [
      summary('w1', { status: 'working', lastActivity: ago(1000) }),
      summary('h1', { lastActivity: ago(60_000) }),
      summary('h2', { lastActivity: ago(5 * DAY_MS) }),
    ];
    const page2 = [
      summary('h3', { lastActivity: ago(6 * DAY_MS) }),
      summary('u1', { unread: true, lastActivity: ago(10 * DAY_MS) }),
      summary('h4', { lastActivity: ago(90 * DAY_MS) }),
    ];
    expect(shape(groupChats(page1, NOW, { hasMore: true }).rows)).toEqual([
      'Last hour (2)',
      'w1',
      'h1',
      'Last 7 days (1+)',
      'h2',
    ]);
    // An unread history chat paged in later stays at its recency position (M3).
    expect(shape(groupChats([...page1, ...page2], NOW).rows)).toEqual([
      'Last hour (2)',
      'w1',
      'h1',
      'Last 7 days (2)',
      'h2',
      'h3',
      'Last 30 days (1)',
      'u1',
      'Older (1)',
      'h4',
    ]);
  });
});

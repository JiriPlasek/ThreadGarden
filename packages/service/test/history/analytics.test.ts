import { describe, expect, it } from 'vitest';
import { queryAnalytics, topicWords } from '../../src/history/analytics.js';
import { openDb, type Db } from '../../src/history/db.js';
import { STATS_VERSION, type SessionStats } from '../../src/history/stats.js';
import type { SDKSessionInfo } from '../../src/sdk/adapter.js';

/** Local times, so the tests hold in every time zone. */
const at = (month: number, day: number, hour = 10): number =>
  new Date(2026, month - 1, day, hour).getTime();
const NOW = at(10, 31, 18); // Saturday 31 October 2026

const row = (day: string, model: string, o: Partial<SessionStats['days'][number]> = {}) => ({
  day,
  model,
  userMessages: 0,
  assistantMessages: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...o,
});

type Fixture = {
  id: string;
  project: string;
  title?: string;
  stats: Partial<SessionStats> & { firstAt: number };
};

const seed = (fixtures: Fixture[], projects: Record<string, string> = {}): Db => {
  const db = openDb(':memory:');
  for (const f of fixtures) {
    const info: SDKSessionInfo = {
      sessionId: f.id,
      lastModified: f.stats.lastAt ?? f.stats.firstAt,
      fileSize: 1,
      cwd: f.project,
      summary: f.title ?? '',
    };
    db.upsertSession(info, f.project);
    db.markIndexed(info);
    db.replaceStats(
      f.id,
      {
        lastAt: f.stats.firstAt,
        days: [],
        hours: [],
        tools: [],
        agents: [],
        ...f.stats,
      },
      STATS_VERSION,
    );
  }
  for (const [projectId, displayName] of Object.entries(projects)) {
    db.upsertProject({ projectId, path: projectId, displayName });
  }
  return db;
};

const fixtures: Fixture[] = [
  {
    id: 'a',
    project: '/w/alpha',
    title: 'Fix the indexer backfill',
    stats: {
      firstAt: at(10, 30, 9),
      days: [
        row('2026-10-30', '', { userMessages: 2 }),
        row('2026-10-30', 'claude-sonnet', {
          assistantMessages: 2,
          inputTokens: 100,
          outputTokens: 1000,
          cacheReadTokens: 5000,
          cacheCreationTokens: 50,
        }),
        row('2026-10-31', '', { userMessages: 1 }),
        row('2026-10-31', 'claude-opus', { assistantMessages: 1, outputTokens: 500 }),
      ],
      hours: [
        { day: '2026-10-30', hour: 9, messages: 4 }, // Friday
        { day: '2026-10-31', hour: 14, messages: 2 }, // Saturday
      ],
      tools: [
        { day: '2026-10-30', name: 'Read', calls: 5 },
        { day: '2026-10-31', name: 'Bash', calls: 2 },
      ],
      agents: [{ day: '2026-10-30', type: 'Explore', calls: 2 }],
    },
  },
  {
    id: 'b',
    project: '/w/beta',
    title: 'Indexer progress in settings',
    stats: {
      firstAt: at(10, 26, 11),
      days: [
        row('2026-10-26', '', { userMessages: 1 }),
        row('2026-10-26', 'claude-sonnet', { assistantMessages: 1, outputTokens: 200 }),
      ],
      hours: [{ day: '2026-10-26', hour: 11, messages: 2 }], // Monday
      tools: [{ day: '2026-10-26', name: 'Read', calls: 1 }],
      agents: [{ day: '2026-10-26', type: 'Plan', calls: 1 }],
    },
  },
  {
    // Outside 7 days and 30 days; inside 90 days.
    id: 'c',
    project: '/w/alpha',
    title: 'Old work on the release',
    stats: {
      firstAt: at(8, 20),
      days: [row('2026-08-20', '', { userMessages: 3 })],
      hours: [{ day: '2026-08-20', hour: 10, messages: 3 }],
      tools: [{ day: '2026-08-20', name: 'Grep', calls: 9 }],
    },
  },
];

describe('queryAnalytics', () => {
  it('aggregates the last 7 days', () => {
    const db = seed(fixtures, { '/w/alpha': 'alpha', '/w/beta': 'beta' });
    const r = queryAnalytics(db, { range: '7d', now: NOW });
    expect(r).toMatchObject({ range: '7d', from: '2026-10-25', to: '2026-10-31', bucket: 'day' });
    expect(r.kpis).toEqual({
      chats: 2,
      messages: 8,
      outputTokens: 1700,
      activeDays: 3,
      busiestProject: { projectId: '/w/alpha', name: 'alpha', messages: 6 },
    });
    expect(r.activity).toHaveLength(7);
    expect(r.activity[0]).toEqual({ day: '2026-10-25', messages: 0, chatsStarted: 0 });
    expect(r.activity.find((d) => d.day === '2026-10-30')).toEqual({
      day: '2026-10-30',
      messages: 4,
      chatsStarted: 1,
    });
    expect(r.activity.find((d) => d.day === '2026-10-26')?.chatsStarted).toBe(1);
    expect(r.tokens.models).toEqual(['claude-sonnet', 'claude-opus']);
    expect(r.tokens.days.find((d) => d.day === '2026-10-30')?.values).toEqual([1000, 0]);
    expect(r.tokens.days.find((d) => d.day === '2026-10-31')?.values).toEqual([0, 500]);
    expect(r.tokens.totals[0]).toEqual({
      model: 'claude-sonnet',
      input: 100,
      output: 1200,
      cacheRead: 5000,
      cacheCreation: 50,
    });
    expect(r.projects).toEqual([
      { projectId: '/w/alpha', name: 'alpha', messages: 6, chats: 1 },
      { projectId: '/w/beta', name: 'beta', messages: 2, chats: 1 },
    ]);
    expect(r.tools).toEqual([
      { name: 'Read', calls: 6 },
      { name: 'Bash', calls: 2 },
    ]);
    expect(r.agents).toEqual([
      { type: 'Explore', calls: 2 },
      { type: 'Plan', calls: 1 },
    ]);
    expect(r.heatmap).toHaveLength(7);
    expect(r.heatmap.every((h) => h.length === 24)).toBe(true);
    expect(r.heatmap[4]![9]).toBe(4); // Friday 09:00
    expect(r.heatmap[5]![14]).toBe(2); // Saturday 14:00
    expect(r.heatmap[0]![11]).toBe(2); // Monday 11:00
    expect(r.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(8);
    expect(r.topics[0]).toEqual({ word: 'indexer', chats: 2 });
    expect(r.pending).toBe(0);
  });

  it('filters to one project', () => {
    const db = seed(fixtures, { '/w/alpha': 'alpha', '/w/beta': 'beta' });
    const r = queryAnalytics(db, { range: '90d', projectId: '/w/alpha', now: NOW });
    expect(r.projectId).toBe('/w/alpha');
    expect(r.kpis.chats).toBe(2);
    expect(r.kpis.messages).toBe(9);
    expect(r.projects.map((p) => p.projectId)).toEqual(['/w/alpha']);
    expect(r.tools.map((t) => t.name)).toEqual(['Grep', 'Read', 'Bash']);
    expect(r.agents).toEqual([{ type: 'Explore', calls: 2 }]);
    expect(r.activity).toHaveLength(90);
  });

  it('"all" starts at the first day with statistics; long spans are bucketed by week', () => {
    const db = seed(fixtures);
    const all = queryAnalytics(db, { range: 'all', now: NOW });
    expect(all.from).toBe('2026-08-20');
    expect(all.bucket).toBe('day');
    expect(all.kpis.messages).toBe(11);
    expect(all.projects[0]?.name).toBe('alpha'); // no project row yet: the folder's name

    const long = seed([
      ...fixtures,
      {
        id: 'old',
        project: '/w/alpha',
        stats: { firstAt: at(1, 7), days: [row('2026-01-07', '', { userMessages: 1 })] },
      },
    ]);
    const weeks = queryAnalytics(long, { range: 'all', now: NOW });
    expect(weeks.bucket).toBe('week');
    expect(weeks.from).toBe('2026-01-05'); // the Monday of that week
    expect(weeks.activity[0]).toEqual({ day: '2026-01-05', messages: 1, chatsStarted: 1 });
    expect(weeks.activity.at(-1)?.day).toBe('2026-10-26');
    expect(weeks.activity.at(-1)?.messages).toBe(8);
    expect(weeks.activity.reduce((n, w) => n + w.messages, 0)).toBe(12);
    expect(weeks.tokens.days).toHaveLength(weeks.activity.length);
  });

  it('folds models after the fourth into Other', () => {
    const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const db = seed([
      {
        id: 'x',
        project: '/w/x',
        stats: {
          firstAt: at(10, 31),
          days: models.map((m, i) => row('2026-10-31', m, { outputTokens: 600 - i * 100 })),
        },
      },
    ]);
    const r = queryAnalytics(db, { range: '7d', now: NOW });
    expect(r.tokens.models).toEqual(['m1', 'm2', 'm3', 'm4', 'Other']);
    expect(r.tokens.days.at(-1)?.values).toEqual([600, 500, 400, 300, 300]);
    expect(r.tokens.totals).toHaveLength(6);
  });

  it('an empty range has zeros everywhere and no busiest project', () => {
    const db = seed([]);
    const r = queryAnalytics(db, { range: '30d', now: NOW });
    expect(r.kpis).toEqual({
      chats: 0,
      messages: 0,
      outputTokens: 0,
      activeDays: 0,
      busiestProject: null,
    });
    expect(r.activity).toHaveLength(30);
    expect(r.tokens.models).toEqual([]);
    expect(r.projects).toEqual([]);
    expect(r.topics).toEqual([]);
    const all = queryAnalytics(db, { range: 'all', now: NOW });
    expect(all.from).toBe('2026-10-31');
    expect(all.activity).toHaveLength(1);
  });

  it('keeps the all-projects sums equal to the per-session rows through replace and delete', () => {
    const db = seed(fixtures, { '/w/alpha': 'alpha', '/w/beta': 'beta' });
    const sums = () =>
      db.raw
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(messages), 0) FROM stats_all_days) AS m,
             (SELECT COALESCE(SUM(user_messages + assistant_messages), 0) FROM stats_days) AS m2,
             (SELECT COALESCE(SUM(output_tokens), 0) FROM stats_all_days) AS o,
             (SELECT COALESCE(SUM(output_tokens), 0) FROM stats_days) AS o2,
             (SELECT COALESCE(SUM(calls), 0) FROM stats_all_tools) AS t,
             (SELECT COALESCE(SUM(calls), 0) FROM stats_tools) AS t2,
             (SELECT COALESCE(SUM(calls), 0) FROM stats_all_agents) AS a,
             (SELECT COALESCE(SUM(calls), 0) FROM stats_agents) AS a2,
             (SELECT COALESCE(SUM(messages), 0) FROM stats_all_hours) AS h,
             (SELECT COALESCE(SUM(messages), 0) FROM stats_hours) AS h2`,
        )
        .get() as Record<string, number>;
    const same = () => {
      const s = sums();
      expect([s.m, s.o, s.t, s.a, s.h]).toEqual([s.m2, s.o2, s.t2, s.a2, s.h2]);
      return s;
    };
    expect(same().m).toBe(11);
    // Re-indexing a: fewer messages and another tool.
    db.replaceStats(
      'a',
      {
        firstAt: at(10, 30, 9),
        lastAt: at(10, 30, 9),
        days: [row('2026-10-30', '', { userMessages: 1 })],
        hours: [{ day: '2026-10-30', hour: 9, messages: 1 }],
        tools: [{ day: '2026-10-30', name: 'Edit', calls: 1 }],
        agents: [],
      },
      STATS_VERSION,
    );
    expect(same().m).toBe(6);
    db.deleteSession('b');
    expect(same().m).toBe(4);
    const r = queryAnalytics(db, { range: '7d', now: NOW });
    expect(r.tools).toEqual([{ name: 'Edit', calls: 1 }]);
    expect(r.agents).toEqual([]);
    expect(r.kpis.messages).toBe(1);
  });

  it('counts indexed chats whose statistics are still pending', () => {
    const db = seed(fixtures);
    const info = { sessionId: 'later', summary: '', lastModified: NOW, fileSize: 1 };
    db.upsertSession(info, '/w/alpha');
    db.markIndexed(info);
    expect(queryAnalytics(db, { range: '7d', now: NOW }).pending).toBe(1);
  });

  it('uses the titles the app shows: a custom title wins', () => {
    const db = seed(fixtures);
    db.setCustomTitle('b', 'Rename the parser');
    const r = queryAnalytics(db, { range: '7d', now: NOW });
    const words = r.topics.map((t) => t.word);
    expect(words).toContain('parser');
    expect(words).not.toContain('settings');
  });
});

describe('topicWords', () => {
  it('ranks meaningful words by the number of titles they appear in', () => {
    const topics = topicWords([
      'Fix the flaky login test',
      'Login page: fix the layout',
      'Why is the login so slow?',
      'Untitled chat',
      'Refactor the parser — and the login',
    ]);
    expect(topics[0]).toEqual({ word: 'login', chats: 4 });
    expect(topics.find((t) => t.word === 'fix')?.chats).toBe(2);
    const words = topics.map((t) => t.word);
    for (const stop of ['the', 'why', 'is', 'so', 'and', 'untitled', 'chat']) {
      expect(words).not.toContain(stop);
    }
  });

  it('drops a word every title has, numbers and short tokens; keeps other scripts', () => {
    const topics = topicWords([
      'Summary 1: oprava přihlášení',
      'Summary 2: přihlášení v2',
      'Summary 3: ui of the app',
      'Summary 4: oprava',
      'Summary 5: přihlášení',
    ]);
    const words = topics.map((t) => t.word);
    expect(words).not.toContain('summary');
    expect(words).not.toContain('v2');
    expect(words).not.toContain('ui');
    expect(topics[0]).toEqual({ word: 'přihlášení', chats: 3 });
  });

  it('keeps at most `limit` words', () => {
    const titles = Array.from(
      { length: 50 },
      (_, i) => `topic${String.fromCharCode(97 + (i % 26))}word`,
    );
    expect(topicWords(titles, 5)).toHaveLength(5);
  });
});

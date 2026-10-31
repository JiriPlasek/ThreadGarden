/**
 * v1.3 analytics (design §4): `analytics.get`, aggregated in SQL over the
 * per-session statistics the indexer stores (`history/stats.ts`). Ranges
 * end today and are made of local calendar days; "all time" starts at the
 * first day with statistics and, past 120 days, is bucketed by week.
 */
import type { Analytics, AnalyticsRange } from '@threadgarden/protocol';
import { baseName, titleFor, UNTITLED_TITLE } from './catalog.js';
import type { Db } from './db.js';
import { localDay, STATS_VERSION } from './stats.js';

const RANGE_DAYS: Record<Exclude<AnalyticsRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
/** "All time" longer than this is shown per week. */
export const MAX_DAY_BUCKETS = 120;
/** Models shown as their own series; the rest are folded into `Other`. */
export const MAX_MODELS = 4;
export const OTHER_MODEL = 'Other';
const TOP = 10;
const TOPICS = 20;

/** What analytics needs of a chat: the title and project the app shows. */
export type ChatTitle = {
  sessionId: string;
  title: string;
  projectId: string;
  projectName: string;
};

export type AnalyticsQuery = {
  range: AnalyticsRange;
  projectId?: string | undefined;
  /** The current time; "today" is its local day. */
  now: number;
  /**
   * The indexed chats with their titles: the catalog's cached corpus (the
   * service), so titles are not read and chosen again per request. Default:
   * read from the database.
   */
  chats?: () => readonly ChatTitle[];
};

/** Chat lookups by id, built once per corpus (the catalog keeps one until it changes). */
const indexes = new WeakMap<readonly ChatTitle[], Map<string, ChatTitle>>();
const chatIndex = (chats: readonly ChatTitle[]): Map<string, ChatTitle> => {
  let index = indexes.get(chats);
  if (!index) {
    index = new Map(chats.map((c) => [c.sessionId, c]));
    indexes.set(chats, index);
  }
  return index;
};

const chatsFromDb = (db: Db, ids?: string[]): ChatTitle[] =>
  (ids?.length === 0 ? [] : db.listSessions(ids ? { ids } : {}, 1_000_000, undefined).items).map(
    (r) => ({
      sessionId: r.sessionId,
      title: titleFor(r),
      projectId: r.projectId,
      projectName: baseName(r.cwd ?? r.projectId),
    }),
  );

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

/** Local midnight of a `YYYY-MM-DD` day (calendar arithmetic, DST-safe). */
const dateOf = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
const addDays = (day: string, n: number): string => {
  const d = dateOf(day);
  d.setDate(d.getDate() + n);
  return localDay(d.getTime());
};
/** The Monday of `day`'s week. */
const mondayOf = (day: string): string => addDays(day, -((dateOf(day).getDay() + 6) % 7));
const daysBetween = (from: string, to: string): number =>
  Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / 86_400_000);

/**
 * Every project: the `stats_all_*` sums, which have no session column; one
 * project: its sessions' rows. Both read as `d` with the same columns.
 */
const sources = (one: boolean) =>
  one
    ? {
        days: `(SELECT day, model, user_messages + assistant_messages AS messages, input_tokens,
            output_tokens, cache_read_tokens, cache_creation_tokens, session_id FROM stats_days)`,
        hours: 'stats_hours',
        tools: 'stats_tools',
        agents: 'stats_agents',
        group: 'GROUP BY d.day, d.model',
        sum: (c: string) => `SUM(d.${c})`,
      }
    : {
        days: 'stats_all_days',
        hours: 'stats_all_hours',
        tools: 'stats_all_tools',
        agents: 'stats_all_agents',
        group: '',
        sum: (c: string) => `d.${c}`,
      };

export const queryAnalytics = (db: Db, q: AnalyticsQuery): Analytics => {
  const raw = db.raw;
  const to = localDay(q.now);
  const one = q.projectId !== undefined;
  const src = sources(one);
  /** Limits a table aliased `d` with a `session_id` column to the project. */
  const project = one
    ? 'AND d.session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)'
    : '';
  const projectParams = one ? [q.projectId as string] : [];

  let from: string;
  if (q.range === 'all') {
    const first = raw
      .prepare(
        `SELECT MIN(d.first_day) AS day FROM stats_sessions d
         WHERE d.first_day <= ? AND d.messages > 0 ${project}`,
      )
      .get(to, ...projectParams)?.day as string | null | undefined;
    from = first ?? to;
  } else {
    from = addDays(to, -(RANGE_DAYS[q.range] - 1));
  }
  const bucket = q.range === 'all' && daysBetween(from, to) + 1 > MAX_DAY_BUCKETS ? 'week' : 'day';
  if (bucket === 'week') from = mondayOf(from);
  // The week of a day, worked out once per day (date arithmetic is the costly part).
  const weeks = new Map<string, string>();
  const keyOf =
    bucket === 'week'
      ? (day: string): string => {
          let week = weeks.get(day);
          if (week === undefined) weeks.set(day, (week = mondayOf(day)));
          return week;
        }
      : (day: string) => day;
  const keys: string[] = [];
  for (let k = keyOf(from); k <= to; k = addDays(k, bucket === 'week' ? 7 : 1)) keys.push(k);
  const index = new Map(keys.map((k, i) => [k, i]));

  /** `WHERE` for a table aliased `d` with a `day` (and, for one project, `session_id`) column. */
  const where = `d.day >= ? AND d.day <= ? ${project}`;
  const params = [from, to, ...projectParams];
  const all = (sql: string, extra: unknown[] = []): Row[] =>
    raw.prepare(sql).all(...(params as string[]), ...(extra as string[]));

  // ── one pass over the days: activity, KPIs and tokens by model ──
  const perDay = all(
    `SELECT d.day AS day, d.model AS model, ${src.sum('messages')} AS messages,
       ${src.sum('input_tokens')} AS input, ${src.sum('output_tokens')} AS output,
       ${src.sum('cache_read_tokens')} AS cache_read,
       ${src.sum('cache_creation_tokens')} AS cache_creation
     FROM ${src.days} d WHERE ${where} ${src.group}`,
  );
  const activity = keys.map((day) => ({ day, messages: 0, chatsStarted: 0 }));
  const activeDays = new Set<string>();
  let messages = 0;
  let outputTokens = 0;
  const byModel = new Map<
    string,
    { model: string; input: number; output: number; cacheRead: number; cacheCreation: number }
  >();
  for (const r of perDay) {
    const day = r.day as string;
    const n = num(r.messages);
    messages += n;
    outputTokens += num(r.output);
    if (n > 0) activeDays.add(day);
    const i = index.get(keyOf(day));
    if (i !== undefined) activity[i]!.messages += n;
    const model = r.model as string;
    if (model === '') continue;
    const t = byModel.get(model) ?? { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    t.input += num(r.input);
    t.output += num(r.output);
    t.cacheRead += num(r.cache_read);
    t.cacheCreation += num(r.cache_creation);
    byModel.set(model, t);
  }
  for (const r of all(
    `SELECT d.first_day AS day, COUNT(*) AS n FROM stats_sessions d
     WHERE d.first_day >= ? AND d.first_day <= ? ${project} GROUP BY d.first_day`,
  )) {
    const i = index.get(keyOf(r.day as string));
    if (i !== undefined) activity[i]!.chatsStarted += num(r.n);
  }

  // ── tokens by model ──
  const totals = [...byModel.values()].sort(
    (a, b) => b.output - a.output || a.model.localeCompare(b.model),
  );
  const shown = totals.length > MAX_MODELS ? totals.slice(0, MAX_MODELS) : totals;
  const models = shown.map((t) => t.model);
  if (totals.length > MAX_MODELS) models.push(OTHER_MODEL);
  const slot = new Map(shown.map((t, i) => [t.model, i]));
  const tokenDays = keys.map((day) => ({ day, values: models.map(() => 0) }));
  for (const r of perDay) {
    const model = r.model as string;
    if (model === '') continue;
    const i = index.get(keyOf(r.day as string));
    if (i === undefined) continue;
    tokenDays[i]!.values[slot.get(model) ?? MAX_MODELS]! += num(r.output);
  }

  // ── the chats in the range: the chats KPI, projects and topics (their titles) ──
  // A chat wholly inside the range counts with its total; only the few that
  // cross the range's start are summed from their days.
  const chatRows = raw
    .prepare(
      `SELECT d.session_id AS id, d.messages AS messages FROM stats_sessions d
       WHERE d.first_day >= ? AND d.last_day <= ? AND d.messages > 0 ${project}
       UNION ALL
       SELECT d.session_id AS id, SUM(d.user_messages + d.assistant_messages) AS messages
       FROM stats_days d WHERE ${where} AND d.session_id IN (SELECT session_id FROM stats_sessions
         WHERE first_day <= ? AND last_day >= ? AND (first_day < ? OR last_day > ?))
       GROUP BY d.session_id HAVING messages > 0`,
    )
    .all(...([...params, ...params, to, from, from, to] as string[]));
  const known = chatIndex(q.chats?.() ?? chatsFromDb(db));
  // Chats the corpus does not know yet (indexed a moment ago) are read from the database.
  const unknown = chatRows.map((r) => r.id as string).filter((id) => !known.has(id));
  const late = new Map(chatsFromDb(db, unknown).map((c) => [c.sessionId, c]));
  const names = new Map(db.listProjects().map((p) => [p.projectId, p.displayName]));
  type ProjectTotal = { projectId: string; name: string; messages: number; chats: number };
  const byProject = new Map<string, ProjectTotal>();
  const titles: string[] = [];
  for (const r of chatRows) {
    const chat = known.get(r.id as string) ?? late.get(r.id as string);
    if (!chat) continue;
    const id = chat.projectId;
    let p = byProject.get(id);
    if (!p) {
      p = { projectId: id, name: names.get(id) ?? chat.projectName, messages: 0, chats: 0 };
      byProject.set(id, p);
    }
    p.messages += num(r.messages);
    p.chats++;
    titles.push(chat.title);
  }
  const chats = titles.length;
  const projects = [...byProject.values()]
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name))
    .slice(0, TOP);

  // ── tools, subagents ──
  const tools = all(
    `SELECT d.tool AS name, SUM(d.calls) AS calls FROM ${src.tools} d WHERE ${where}
     GROUP BY d.tool HAVING calls > 0 ORDER BY calls DESC, name LIMIT ${TOP}`,
  ).map((r) => ({ name: r.name as string, calls: num(r.calls) }));
  const agents = all(
    `SELECT d.agent_type AS type, SUM(d.calls) AS calls FROM ${src.agents} d WHERE ${where}
     GROUP BY d.agent_type HAVING calls > 0 ORDER BY calls DESC, type LIMIT ${TOP}`,
  ).map((r) => ({ type: r.type as string, calls: num(r.calls) }));

  // ── weekday × hour ──
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of all(
    `SELECT CAST(strftime('%w', d.day) AS INTEGER) AS wd, d.hour AS hour, SUM(d.messages) AS n
     FROM ${src.hours} d WHERE ${where} GROUP BY wd, hour`,
  )) {
    const hour = num(r.hour);
    if (hour < 0 || hour > 23) continue;
    heatmap[(num(r.wd) + 6) % 7]![hour]! += num(r.n); // SQLite's 0 is Sunday; ours is Monday
  }

  const busiest = projects[0];
  return {
    range: q.range,
    ...(q.projectId === undefined ? {} : { projectId: q.projectId }),
    from,
    to,
    bucket,
    kpis: {
      chats,
      messages,
      outputTokens,
      activeDays: activeDays.size,
      busiestProject: busiest
        ? { projectId: busiest.projectId, name: busiest.name, messages: busiest.messages }
        : null,
    },
    activity,
    tokens: { models, days: tokenDays, totals },
    projects,
    tools,
    agents,
    heatmap,
    topics: topicWords(titles, TOPICS),
    pending: pendingStats(db),
  };
};

/**
 * Indexed chats still without current statistics, for the "still gathering"
 * note: two counts instead of `countSessionsNeedingStats`'s join (statistics
 * exist only for indexed sessions, and go with them).
 */
const pendingStats = (db: Db): number => {
  const r = db.raw
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE indexed_modified IS NOT NULL)
         - (SELECT COUNT(*) FROM stats_sessions WHERE version >= ?) AS n`,
    )
    .get(STATS_VERSION);
  return Math.max(0, num(r?.n));
};

/**
 * English function words and the filler of chat titles; they say nothing
 * about what a chat was about. (Titles in other languages keep all words.)
 */
const STOP_WORDS = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been ' +
    'before being below between both but by can cannot could couldn did didn do does doesn ' +
    'doing don down during each few for from further get got had has have having he her here ' +
    'hers herself him himself his how however i if in into is isn it its itself just let lets ' +
    'like me more most my myself no nor not now of off on once only or other our ours out over ' +
    'own same she should so some such than that the their theirs them then there these they ' +
    'this those through to too under until up very was we were what when where which while who ' +
    'whom why will with without would you your yours yourself ' +
    // chat filler
    'please help hey hello thanks thank okay yes want need make use using way thing things ' +
    'something anything everything one two new chat claude untitled ' +
    "can't don't doesn't isn't it's i'm let's what's"
  ).split(/\s+/),
);

/** Titles change rarely: their words are kept, up to this many titles. */
const WORDS_CACHE_MAX = 20_000;
const wordsCache = new Map<string, readonly string[]>();

/** A title's distinct meaningful words (cached). */
const wordsOf = (title: string): readonly string[] => {
  const known = wordsCache.get(title);
  if (known) return known;
  const words = new Set<string>();
  for (const m of title
    .toLowerCase()
    .normalize('NFC')
    .matchAll(/\p{L}[\p{L}\p{N}'’_-]*/gu)) {
    const w = m[0].replace(/[’]/g, "'").replace(/['_-]+$/, '');
    if ([...w].length < 3 || STOP_WORDS.has(w)) continue;
    words.add(w);
  }
  if (wordsCache.size >= WORDS_CACHE_MAX) wordsCache.clear();
  const out = [...words];
  wordsCache.set(title, out);
  return out;
};

/**
 * The words that appear in the most titles (each counted once per title),
 * best first. Function words, numbers and words under 3 letters are left
 * out, and so is a word every one of five or more titles shares (a common
 * prefix tells nothing apart). With 10 titles or more, a word must appear
 * in at least two.
 */
export const topicWords = (titles: readonly string[], limit = TOPICS) => {
  const real = titles.filter((t) => t && t !== UNTITLED_TITLE);
  const counts = new Map<string, number>();
  for (const title of real) {
    for (const w of wordsOf(title)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const min = real.length >= 10 ? 2 : 1;
  return [...counts]
    .filter(([, n]) => n >= min && !(real.length >= 5 && n === real.length))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, chats]) => ({ word, chats }));
};

/**
 * Deterministic synthetic history for indexer tests and perf budgets: sessions
 * spread over projects, plus an optional "big" session of many ~10 KB messages.
 */
import type { SDKSessionInfo, SessionMessage } from '../sdk/adapter.js';
import { FakeAdapter } from './fake-adapter.js';

const WORDS = (
  'parity refactor migration indexer socket token render cache latency parser schema query ' +
  'branch commit review deploy rollback config adapter session stream buffer normalize ' +
  'worktree project memory timeout retry layout widget keyboard shortcut notification'
).split(' ');

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const sentence = (next: () => number, words: number): string => {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(next() * WORDS.length)] as string);
  return out.join(' ');
};

const message = (
  sessionId: string,
  n: number,
  type: 'user' | 'assistant',
  text: string,
): SessionMessage => ({
  type,
  uuid: `${sessionId}-m${n}`,
  session_id: sessionId,
  message:
    type === 'user'
      ? { role: 'user', content: text }
      : { role: 'assistant', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

const DAY_MS = 86_400_000;
const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];
const TOOLS = ['Read', 'Read', 'Read', 'Edit', 'Edit', 'Bash', 'Bash', 'Grep', 'Glob', 'Write'];
const TOOLS_RARE = ['TodoWrite', 'WebFetch', 'MultiEdit', 'NotebookEdit'];
const SUBAGENTS = ['Explore', 'Explore', 'general-purpose', 'Plan', 'code-reviewer'];

/**
 * Start times of `n` sessions within the last `days` days before `now`, in
 * ascending order (session i stays older than session i + 1, as in the plain
 * corpus): mostly on weekdays and in working hours, more of them recently.
 */
const startTimes = (n: number, recent: { now: number; days: number }, next: () => number) => {
  const span = recent.days * DAY_MS;
  const out: number[] = [];
  while (out.length < n) {
    const t = recent.now - span * next() ** 1.4;
    const d = new Date(t);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const hour = d.getHours();
    const busy = hour >= 9 && hour < 19 ? 1 : hour >= 7 && hour < 23 ? 0.35 : 0.05;
    if (next() < busy * (weekend ? 0.3 : 1)) out.push(Math.floor(t));
  }
  return out.sort((a, b) => a - b);
};

/**
 * v1.3 analytics: dates the session's messages from `start` on and gives its
 * assistant messages a model, token usage and tool calls, the way Claude Code
 * transcripts carry them.
 */
const enrich = (
  sessionId: string,
  messages: SessionMessage[],
  next: () => number,
  start: number,
): number => {
  let t = start;
  let model = MODELS[next() < 0.6 ? 0 : next() < 0.75 ? 1 : 2] as string;
  let toolN = 0;
  for (const [n, m] of messages.entries()) {
    t += 30_000 + Math.floor(next() * 150_000);
    const raw = m as unknown as Record<string, unknown>;
    raw.timestamp = new Date(t).toISOString();
    if (m.type !== 'assistant') continue;
    if (next() < 0.05) model = MODELS[Math.floor(next() * MODELS.length)] as string;
    const msg = m.message as { content: unknown[] } & Record<string, unknown>;
    msg.id = `msg-${sessionId}-${n}`;
    msg.model = model;
    msg.usage = {
      input_tokens: 200 + Math.floor(next() * 3_800),
      output_tokens: 100 + Math.floor(next() * 1_900),
      cache_read_input_tokens: 5_000 + Math.floor(next() * 55_000),
      cache_creation_input_tokens: Math.floor(next() * 5_000),
    };
    const calls = Math.floor(next() * 4);
    for (let k = 0; k < calls; k++) {
      const id = `toolu-${sessionId}-${toolN++}`;
      const r = next();
      if (r < 0.08) {
        const subagent = SUBAGENTS[Math.floor(next() * SUBAGENTS.length)];
        msg.content.push({
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { subagent_type: subagent },
        });
      } else {
        const pool = r < 0.15 ? TOOLS_RARE : TOOLS;
        msg.content.push({
          type: 'tool_use',
          id,
          name: pool[Math.floor(next() * pool.length)],
          input: {},
        });
      }
    }
  }
  return t;
};

export const generateCorpus = (o: {
  sessions: number;
  projects: number;
  bigSessionMessages: number;
  /**
   * v1.3 analytics: date the sessions within the last `days` days before
   * `now`, with models, token usage and tool calls (the mock service). Without
   * it the corpus is the same as before, so the older perf budgets measure the
   * same work.
   */
  recent?: { now: number; days: number };
}): FakeAdapter => {
  const adapter = new FakeAdapter();
  const next = rng(42);
  const richNext = rng(7);
  const base = 1_700_000_000_000;
  const projectCount = Math.max(1, o.projects);
  const starts = o.recent ? startTimes(o.sessions, o.recent, richNext) : [];
  let lastModified = 0;

  for (let i = 0; i < o.sessions; i++) {
    const sessionId = `session-${i}`;
    const messages: SessionMessage[] = [];
    const count = 4 + Math.floor(next() * 5);
    for (let n = 0; n < count; n++) {
      messages.push(message(sessionId, n, n % 2 === 0 ? 'user' : 'assistant', sentence(next, 40)));
    }
    const info: SDKSessionInfo = {
      sessionId,
      summary: `Summary ${i}: ${sentence(next, 4)}`,
      lastModified: base + i * 60_000,
      fileSize: 2_000 + i,
      firstPrompt: sentence(next, 6),
      cwd: `/work/proj-${i % projectCount}`,
      createdAt: base + i * 60_000 - 5_000,
    };
    if (o.recent) {
      const start = starts[i] as number;
      const end = enrich(sessionId, messages, richNext, start);
      // Strictly increasing, so lists keep the plain corpus's order (UI tests rely on it).
      lastModified = Math.max(Math.min(end, o.recent.now - (o.sessions - i)), lastModified + 1);
      info.createdAt = start;
      info.lastModified = lastModified;
    }
    adapter.sessions.set(sessionId, { info, messages });
  }

  if (o.bigSessionMessages > 0) {
    const sessionId = 'session-big';
    const messages: SessionMessage[] = [];
    for (let n = 0; n < o.bigSessionMessages; n++) {
      messages.push(
        message(sessionId, n, n % 2 === 0 ? 'user' : 'assistant', sentence(next, 1500)),
      );
    }
    const info: SDKSessionInfo = {
      sessionId,
      summary: 'A very long session',
      lastModified: base + o.sessions * 60_000 + 1,
      fileSize: o.bigSessionMessages * 10_000,
      cwd: '/work/proj-0',
    };
    if (o.recent) {
      // Still the newest session, as in the plain corpus; its messages ran over the last days.
      const start = o.recent.now - 3 * DAY_MS;
      enrich(sessionId, messages, richNext, start);
      info.createdAt = start;
      info.lastModified = Math.max(lastModified + 1, o.recent.now - 1);
    }
    adapter.sessions.set(sessionId, { info, messages });
  }
  return adapter;
};

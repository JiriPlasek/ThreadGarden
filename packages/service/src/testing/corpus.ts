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

export const generateCorpus = (o: {
  sessions: number;
  projects: number;
  bigSessionMessages: number;
}): FakeAdapter => {
  const adapter = new FakeAdapter();
  const next = rng(42);
  const base = 1_700_000_000_000;
  const projectCount = Math.max(1, o.projects);

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
    adapter.sessions.set(sessionId, {
      info: {
        sessionId,
        summary: 'A very long session',
        lastModified: base + o.sessions * 60_000 + 1,
        fileSize: o.bigSessionMessages * 10_000,
        cwd: '/work/proj-0',
      },
      messages,
    });
  }
  return adapter;
};

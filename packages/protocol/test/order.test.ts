import { describe, expect, it } from 'vitest';
import { compareChats, sidebarTime, statusRank, type ChatStatus } from '../src/index.js';

const chat = (sessionId: string, status: ChatStatus, lastActivity: number) => ({
  sessionId,
  status,
  lastActivity,
});

describe('chat display order', () => {
  it('uses stable sidebar recency and preserves legacy fallback, including zero', () => {
    expect(sidebarTime({ lastActivity: 10 })).toBe(10);
    expect(sidebarTime({ lastActivity: 10, sortAt: 0 })).toBe(0);
    const older = { ...chat('old', 'working', 100), sortAt: 1 };
    const newer = { ...chat('new', 'history', 2), sortAt: 2 };
    for (const status of ['working', 'idle', 'needsYou'] as const) {
      expect(
        [{ ...older, status, lastActivity: 1000 }, newer]
          .sort(compareChats)
          .map((c) => c.sessionId),
      ).toEqual(['new', 'old']);
    }
  });
  it('ranks needs you, then working, then idle, then history', () => {
    expect(statusRank('needsYou')).toBeLessThan(statusRank('working'));
    expect(statusRank('working')).toBe(statusRank('unknown'));
    expect(statusRank('working')).toBeLessThan(statusRank('idle'));
    expect(statusRank('idle')).toBe(statusRank('paused'));
    expect(statusRank('idle')).toBe(statusRank('failed'));
    expect(statusRank('idle')).toBeLessThan(statusRank('history'));
  });

  it('orders by time regardless of status, then session id', () => {
    const list = [
      chat('h-old', 'history', 1),
      chat('b', 'history', 5),
      chat('a', 'history', 5),
      chat('idle', 'idle', 0),
      chat('waiting', 'needsYou', 0),
    ];
    expect(list.sort(compareChats).map((c) => c.sessionId)).toEqual([
      'a',
      'b',
      'h-old',
      'idle',
      'waiting',
    ]);
  });
});

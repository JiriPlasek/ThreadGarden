import { describe, expect, it } from 'vitest';
import { compareChats, statusRank, type ChatStatus } from '../src/index.js';

const chat = (sessionId: string, status: ChatStatus, lastActivity: number) => ({
  sessionId,
  status,
  lastActivity,
});

describe('chat display order', () => {
  it('ranks needs you, then working, then idle, then history', () => {
    expect(statusRank('needsYou')).toBeLessThan(statusRank('working'));
    expect(statusRank('working')).toBe(statusRank('unknown'));
    expect(statusRank('working')).toBeLessThan(statusRank('idle'));
    expect(statusRank('idle')).toBe(statusRank('paused'));
    expect(statusRank('idle')).toBe(statusRank('failed'));
    expect(statusRank('idle')).toBeLessThan(statusRank('history'));
  });

  it('orders by status, then most recent first, then session id', () => {
    const list = [
      chat('h-old', 'history', 1),
      chat('b', 'history', 5),
      chat('a', 'history', 5),
      chat('idle', 'idle', 0),
      chat('waiting', 'needsYou', 0),
    ];
    expect(list.sort(compareChats).map((c) => c.sessionId)).toEqual([
      'waiting',
      'idle',
      'a',
      'b',
      'h-old',
    ]);
  });
});

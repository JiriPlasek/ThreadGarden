import type { ChatStatus, ChatSummary } from './chat.js';

/** Display order of a status: needs you → working → idle/paused/failed → everything else (history). */
export const statusRank = (s: ChatStatus): number => {
  switch (s) {
    case 'needsYou':
      return 0;
    case 'working':
    case 'unknown':
      return 1;
    case 'idle':
    case 'paused':
    case 'failed':
      return 2;
    default:
      return 3;
  }
};

/** Sidebar recency with fallback for peers predating stable ordering. */
export const sidebarTime = (value: { lastActivity: number; sortAt?: number }): number =>
  value.sortAt ?? value.lastActivity;

/** Most recent sidebar activity first, with a deterministic tie break. */
export const compareChats = (
  a: Pick<ChatSummary, 'lastActivity' | 'sortAt' | 'sessionId'>,
  b: Pick<ChatSummary, 'lastActivity' | 'sortAt' | 'sessionId'>,
): number => sidebarTime(b) - sidebarTime(a) || a.sessionId.localeCompare(b.sessionId);

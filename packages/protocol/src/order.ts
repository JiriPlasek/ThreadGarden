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

/**
 * The order `sessions.list` lists a place's chats in: by status
 * (`statusRank`), then most recent first, then by session id. The index rows
 * after the live and external ones are all history, so a whole page follows it.
 * The UI merges several machines' pages with it.
 */
export const compareChats = (
  a: Pick<ChatSummary, 'status' | 'lastActivity' | 'sessionId'>,
  b: Pick<ChatSummary, 'status' | 'lastActivity' | 'sessionId'>,
): number =>
  statusRank(a.status) - statusRank(b.status) ||
  b.lastActivity - a.lastActivity ||
  a.sessionId.localeCompare(b.sessionId);

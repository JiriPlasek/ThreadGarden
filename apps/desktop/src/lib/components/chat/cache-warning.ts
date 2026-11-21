import type { ChatHeaderInfo } from '@threadgarden/protocol';
import { tokens } from './format';

/** From this share of the context window, re-reading the context uncached is worth a word. */
export const CACHE_WARNING_SHARE = 0.2;
/** The window assumed when no run of the chat (or of its model) has said its size. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

type CacheHeader = Pick<ChatHeaderInfo, 'runtime' | 'lastReply' | 'contextUsage' | 'contextTokens'>;

/** When the last reply's prompt cache runs out; undefined before a reply. */
export const cacheExpiresAt = (header: CacheHeader): number | undefined =>
  header.runtime !== 'codex' && header.lastReply
    ? header.lastReply.at + header.lastReply.cacheTtlMs
    : undefined;

/**
 * "Cache expired · re-reads 180k tokens" when the next message sends the whole
 * context again uncached: the last reply is older than its prompt cache's
 * lifetime (5 min or 1 h), and the context fills at least 20% of its window
 * (200k when the size is not known). Null otherwise, and after a compaction
 * that came since the reply (Claude Code's idle compaction, `/compact`).
 */
export const cacheWarning = (header: CacheHeader, now: number): string | null => {
  // A compaction since (idle compaction, /compact): the next message sends the summary.
  if (header.lastReply?.compacted) return null;
  const expires = cacheExpiresAt(header);
  if (expires === undefined || now < expires) return null;
  const used = header.contextUsage?.used ?? header.contextTokens;
  if (used === undefined) return null;
  const max = header.contextUsage?.max ?? DEFAULT_CONTEXT_WINDOW;
  if (used < CACHE_WARNING_SHARE * max) return null;
  return `Cache expired · re-reads ${tokens(used)} tokens`;
};

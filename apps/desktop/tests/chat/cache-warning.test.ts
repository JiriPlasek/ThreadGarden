import { describe, expect, it } from 'vitest';
import { cacheExpiresAt, cacheWarning } from '../../src/lib/components/chat/cache-warning';

const MIN = 60_000;
const at = 1_000_000;
const lastReply = { at, cacheTtlMs: 5 * MIN };

describe('cacheWarning', () => {
  it('does not apply Claude cache lifetime assumptions to Codex', () => {
    const header = {
      runtime: 'codex' as const,
      lastReply,
      contextUsage: { used: 180_000, max: 200_000 },
    };
    expect(cacheExpiresAt(header)).toBeUndefined();
    expect(cacheWarning(header, at + 10 * MIN)).toBeNull();
  });
  it('once the cache has expired, a context of 20%+ of the window warns with its tokens', () => {
    const header = { lastReply, contextUsage: { used: 180_000, max: 200_000 } };
    expect(cacheWarning(header, at + 5 * MIN - 1)).toBeNull();
    expect(cacheWarning(header, at + 5 * MIN)).toBe('Cache expired · re-reads 180k tokens');
  });

  it('a context under 20% of its window is cheap to re-read: no warning', () => {
    const later = at + 2 * 60 * MIN;
    expect(
      cacheWarning({ lastReply, contextUsage: { used: 199_999, max: 1_000_000 } }, later),
    ).toBeNull();
    expect(
      cacheWarning({ lastReply, contextUsage: { used: 200_000, max: 1_000_000 } }, later),
    ).toBe('Cache expired · re-reads 200k tokens');
  });

  it('a 1-hour cache is still warm after 5 minutes', () => {
    const header = {
      lastReply: { at, cacheTtlMs: 60 * MIN },
      contextUsage: { used: 100_000, max: 200_000 },
    };
    expect(cacheWarning(header, at + 30 * MIN)).toBeNull();
    expect(cacheWarning(header, at + 60 * MIN)).not.toBeNull();
  });

  it("without the window's size, the history's tokens against a 200k window", () => {
    const later = at + 10 * MIN;
    expect(cacheWarning({ lastReply, contextTokens: 39_999 }, later)).toBeNull();
    expect(cacheWarning({ lastReply, contextTokens: 40_000 }, later)).toBe(
      'Cache expired · re-reads 40k tokens',
    );
  });

  it('after a compaction (idle compaction, /compact) the next message sends the summary: no warning', () => {
    const header = {
      lastReply: { ...lastReply, compacted: true as const },
      contextUsage: { used: 250_000, max: 1_000_000 },
    };
    expect(cacheWarning(header, at + 2 * 60 * MIN)).toBeNull();
  });

  it('no reply yet, or no tokens known: nothing to say', () => {
    expect(cacheWarning({ contextUsage: { used: 180_000, max: 200_000 } }, at * 2)).toBeNull();
    expect(cacheWarning({ lastReply }, at * 2)).toBeNull();
  });

  it('cacheExpiresAt says when to look again', () => {
    expect(cacheExpiresAt({ lastReply })).toBe(at + 5 * MIN);
    expect(cacheExpiresAt({})).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { codexTokens, codexUsage } from '../../src/sdk/codex-usage.js';
import { readingFromUsage, UsageTracker } from '../../src/usage/usage.js';
import { realTimers } from '../../src/chat/live-session.js';
import { openDb } from '../../src/history/db.js';

const account = { account: { type: 'chatgpt', email: 'same@example.test', planType: 'pro' } };
describe('Codex usage', () => {
  it('uses native percentages, durations, and reset times without inferring a rejection from percentage alone', () => {
    const raw = codexUsage(
      {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1900000000 },
          secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1900100000 },
        },
      },
      account,
    );
    const parsed = readingFromUsage(raw, 1000)!;
    expect(parsed.windows).toMatchObject([
      { key: 'five_hour', utilization: 42, resetsAt: 1900000000000, status: 'allowed' },
      { key: 'seven_day', utilization: 100, status: 'allowed_warning' },
    ]);
    expect(raw.account).toMatchObject({
      runtime: 'codex',
      kind: 'login',
      email: 'same@example.test',
    });
  });
  it('keeps independent quota buckets and respects backend rejection state', () => {
    const raw = codexUsage(
      {
        ordinaryUsageAllowed: false,
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 100, windowDurationMins: 300 } },
          review: { limitName: 'Reviews', primary: { usedPercent: 20, windowDurationMins: 60 } },
        },
      },
      account,
    );
    expect(readingFromUsage(raw, 1000)?.windows).toMatchObject([
      { key: 'five_hour', status: 'rejected' },
      { key: 'codex:review:primary', label: 'Reviews · 60 min' },
    ]);
  });
  it('does not present subscription limits for an API key and subtracts cached input from uncached tokens', () => {
    expect(codexUsage({}, { account: { type: 'apiKey' } })).toMatchObject({
      rate_limits_available: false,
      account: { kind: 'apiKey', runtime: 'codex' },
    });
    expect(codexTokens({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 })).toEqual({
      input_tokens: 60,
      cache_read_input_tokens: 40,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
    });
  });
  it('persists Claude and Codex independently, including after one account signs in as someone else', () => {
    const db = openDb(':memory:');
    const base = {
      raw: db.raw,
      now: () => 1000,
      timers: realTimers,
      emit: () => {},
      onError: (error: unknown) => {
        throw error;
      },
    };
    try {
      const claude = new UsageTracker(base);
      const codex = new UsageTracker({ ...base, runtime: 'codex' });
      claude.noteAccount({ kind: 'login', email: 'same@example.test' });
      codex.noteAccount({ kind: 'login', email: 'same@example.test', runtime: 'codex' });
      claude.observeEvent('claude-chat', {
        rateLimitType: 'five_hour',
        utilization: 0.9,
        status: 'rejected',
        resetsAt: 1900000000,
      });
      codex.observeEvent('codex-chat', {
        rateLimitType: 'five_hour',
        utilization: 0.2,
        status: 'allowed',
        resetsAt: 1900100000,
      });
      expect(new UsageTracker(base).state().windows[0]?.utilization).toBe(90);
      expect(new UsageTracker({ ...base, runtime: 'codex' }).state().windows[0]?.utilization).toBe(
        20,
      );
      claude.noteAccount({ kind: 'login', email: 'someoneelse@example.test' });
      expect(new UsageTracker({ ...base, runtime: 'codex' }).state().windows[0]?.utilization).toBe(
        20,
      );
      expect(codex.limitResetAt()).toBeUndefined();
      expect(claude.state().windows).toEqual([]);
      codex.noteAccount({ kind: 'apiKey', runtime: 'codex' });
      expect(codex.state().windows).toEqual([]);
    } finally {
      db.close();
    }
  });
});

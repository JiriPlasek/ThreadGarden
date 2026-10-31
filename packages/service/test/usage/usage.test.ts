import type { UsageState } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/history/db.js';
import {
  USAGE_READ_INTERVAL_MS,
  USAGE_READ_TIMEOUT_MS,
  UsageTracker,
  readingFromUsage,
  refusesTurn,
  toEpochMs,
  windowsFromEvent,
} from '../../src/usage/usage.js';
import { realTimers } from '../../src/chat/live-session.js';

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

describe('toEpochMs', () => {
  it('takes seconds, milliseconds, numeric strings and ISO dates', () => {
    expect(toEpochMs(1_793_000_000)).toBe(1_793_000_000_000);
    expect(toEpochMs(1_793_000_000_000)).toBe(1_793_000_000_000);
    expect(toEpochMs('1793000000')).toBe(1_793_000_000_000);
    expect(toEpochMs('2026-10-31T15:00:00Z')).toBe(Date.UTC(2026, 9, 31, 15));
  });

  it('drops what is not a time', () => {
    for (const v of [undefined, null, 0, -5, Number.NaN, '', 'soon', {}]) {
      expect(toEpochMs(v)).toBeUndefined();
    }
  });
});

describe('windowsFromEvent', () => {
  it('maps a rate-limit event to its window, utilization as a percentage', () => {
    expect(
      windowsFromEvent(
        {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.82,
          resetsAt: 1_793_000_000,
        },
        T0,
      ),
    ).toEqual([
      {
        key: 'five_hour',
        status: 'allowed_warning',
        utilization: 82,
        resetsAt: 1_793_000_000_000,
        observedAt: T0,
        source: 'event',
      },
    ]);
  });

  it('adds the overage state, and tolerates missing or unknown fields', () => {
    const ws = windowsFromEvent(
      { status: 'rejected', overageStatus: 'allowed', overageResetsAt: 1_793_000_000, x: 1 },
      T0,
    );
    expect(ws).toEqual([
      { key: 'current', status: 'rejected', observedAt: T0, source: 'event' },
      {
        key: 'overage',
        status: 'allowed',
        resetsAt: 1_793_000_000_000,
        observedAt: T0,
        source: 'event',
      },
    ]);
    expect(windowsFromEvent({ status: 'weird', utilization: 'high' }, T0)).toEqual([
      { key: 'current', observedAt: T0, source: 'event' },
    ]);
    expect(windowsFromEvent(null, T0)).toEqual([]);
  });

  it('a rejected limit refuses the turn unless overage carries it', () => {
    expect(refusesTurn({ status: 'rejected' })).toBe(true);
    expect(refusesTurn({ status: 'rejected', overageStatus: 'rejected' })).toBe(true);
    expect(refusesTurn({ status: 'rejected', overageStatus: 'allowed' })).toBe(false);
    expect(refusesTurn({ status: 'allowed_warning' })).toBe(false);
    expect(refusesTurn('rejected')).toBe(false);
  });
});

describe('readingFromUsage', () => {
  const resp = {
    session: { total_cost_usd: 1 },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 37, resets_at: '2026-10-31T15:00:00Z' },
      seven_day: { utilization: 12.5, resets_at: '2026-11-04T09:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 4, resets_at: null }, { bad: 1 }],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 50,
        used_credits: 12,
        utilization: 24,
        currency: 'USD',
      },
      future_window: { utilization: 1, resets_at: null, more: true },
    },
    behaviors: null,
  };

  it('reads every window it can, leniently', () => {
    const r = readingFromUsage(resp, T0)!;
    expect(r.subscriptionType).toBe('max');
    expect(r.rateLimitsAvailable).toBe(true);
    const byKey = new Map(r.windows.map((w) => [w.key, w]));
    expect([...byKey.keys()].sort()).toEqual([
      'extra_usage',
      'five_hour',
      'future_window',
      'model:Fable',
      'seven_day',
    ]);
    expect(byKey.get('five_hour')).toEqual({
      key: 'five_hour',
      utilization: 37,
      resetsAt: Date.UTC(2026, 9, 31, 15),
      observedAt: T0,
      source: 'usage',
    });
    expect(byKey.get('model:Fable')).toMatchObject({ label: 'Fable', utilization: 4 });
    expect(byKey.get('extra_usage')).toMatchObject({
      utilization: 24,
      credits: { enabled: true, used: 12, limit: 50, currency: 'USD' },
    });
  });

  it('API-key accounts: plan limits do not apply', () => {
    expect(
      readingFromUsage(
        { subscription_type: null, rate_limits_available: false, rate_limits: null },
        T0,
      ),
    ).toEqual({ windows: [], rateLimitsAvailable: false });
  });

  it('an answer of another shape is not a reading', () => {
    expect(readingFromUsage(undefined, T0)).toBeUndefined();
    expect(readingFromUsage({ hello: 1 }, T0)).toBeUndefined();
    expect(readingFromUsage([1, 2], T0)).toBeUndefined();
  });
});

describe('UsageTracker', () => {
  let db: Db;
  let now: number;
  let emitted: UsageState[];
  let errors: string[];

  const tracker = (raw = db.raw) =>
    new UsageTracker({
      raw,
      now: () => now,
      emit: (s) => emitted.push(s),
      timers: realTimers,
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });

  beforeEach(() => {
    db = openDb(':memory:');
    now = T0;
    emitted = [];
    errors = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('keeps the latest state per window, account-wide, and announces changes only', () => {
    const t = tracker();
    t.observeEvent('a', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 });
    t.observeEvent('b', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1 });
    now += 1000;
    t.observeEvent('b', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 });
    expect(emitted).toHaveLength(2); // the third changed nothing but the observed time
    const s = t.state();
    expect(s.windows.map((w) => [w.key, w.utilization, w.observedAt])).toEqual([
      ['five_hour', 40, T0 + 1000],
      ['seven_day', 10, T0],
    ]);
  });

  it('persists windows and the account across restarts', async () => {
    const t = tracker();
    t.observeEvent('a', {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.9,
      resetsAt: T0 / 1000 + 3600,
    });
    await t.refresh(async () => ({ subscription_type: 'pro', rate_limits_available: true }));
    const again = tracker();
    expect(again.state()).toEqual({
      windows: [
        {
          key: 'five_hour',
          status: 'allowed_warning',
          utilization: 90,
          resetsAt: T0 + 3_600_000,
          observedAt: T0,
          source: 'event',
        },
      ],
      subscriptionType: 'pro',
      rateLimitsAvailable: true,
      refused: [],
    });
  });

  it('a corrupt stored row is ignored', () => {
    db.raw
      .prepare("INSERT INTO usage_limits (key, json, observed_at) VALUES ('five_hour', '{', 1)")
      .run();
    db.raw
      .prepare("INSERT INTO usage_limits (key, json, observed_at) VALUES ('seven_day', '[]', 1)")
      .run();
    expect(tracker().state().windows).toEqual([]);
  });

  it('a rejected event or a rate_limit error marks the chat refused, with the reset time', () => {
    const t = tracker();
    const reset = T0 + 2 * 3_600_000;
    t.noteRefusal('a');
    t.observeEvent('b', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    expect(t.limitResetAt()).toBe(reset);
    expect(t.state().refused).toEqual([
      { sessionId: 'a', at: T0, resetsAt: reset },
      { sessionId: 'b', at: T0, resetsAt: reset },
    ]);
    expect(t.isRefused('a')).toBe(true);
  });

  it('the refusal stays after the refused turn and clears when a later turn goes through', () => {
    const t = tracker();
    t.noteRefusal('a');
    expect(t.turnEnded('a')).toBe(true);
    expect(t.isRefused('a')).toBe(true);
    emitted = [];
    expect(t.turnEnded('a')).toBe(false);
    expect(t.isRefused('a')).toBe(false);
    expect(emitted.at(-1)?.refused).toEqual([]);
  });

  it('a reset that has passed no longer limits', () => {
    const t = tracker();
    t.observeEvent('a', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: T0 + 60_000 });
    expect(t.limitResetAt()).toBe(T0 + 60_000);
    now = T0 + 60_001;
    expect(t.limitResetAt()).toBeUndefined();
  });

  it('a usage reading keeps the event status of the same window, and drops it after a reset', async () => {
    const t = tracker();
    const reset = T0 + 3_600_000;
    t.observeEvent('a', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    now += USAGE_READ_INTERVAL_MS;
    await t.refresh(async () => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 100, resets_at: new Date(reset).toISOString() } },
    }));
    expect(t.state().windows[0]).toMatchObject({
      status: 'rejected',
      utilization: 100,
      source: 'usage',
    });
    now += USAGE_READ_INTERVAL_MS;
    await t.refresh(async () => ({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 3, resets_at: new Date(reset + 5 * 3_600_000).toISOString() },
      },
    }));
    expect(t.state().windows[0]!.status).toBeUndefined();
  });

  it('reads usage at most once a minute and only with a running session', async () => {
    const t = tracker();
    const read = vi.fn(async () => ({ rate_limits_available: true, rate_limits: {} }));
    await t.refresh(undefined);
    await t.refresh(read);
    await t.refresh(read);
    expect(read).toHaveBeenCalledTimes(1);
    now += USAGE_READ_INTERVAL_MS - 1;
    await t.refresh(read);
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    await t.refresh(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a failing, odd or hanging reading falls back silently (logged)', async () => {
    const t = tracker();
    t.observeEvent('a', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
    const before = t.state();
    await t.refresh(async () => {
      throw new Error('Unknown control request');
    });
    now += USAGE_READ_INTERVAL_MS;
    await t.refresh(async () => 'nope');
    vi.useFakeTimers();
    now += USAGE_READ_INTERVAL_MS;
    const hanging = t.refresh(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(USAGE_READ_TIMEOUT_MS);
    await hanging;
    expect(t.state()).toEqual(before);
    expect(errors).toEqual([
      'usage reading failed: Unknown control request',
      'usage reading had an unexpected shape',
      'usage reading failed: the usage reading timed out',
    ]);
  });

  it('works without a database', () => {
    const t = new UsageTracker({
      now: () => now,
      emit: () => {},
      timers: realTimers,
      onError: () => {},
    });
    t.observeEvent('a', { status: 'allowed', rateLimitType: 'five_hour' });
    expect(t.state().windows).toHaveLength(1);
  });
});

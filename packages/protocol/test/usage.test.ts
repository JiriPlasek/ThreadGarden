import { describe, expect, it } from 'vitest';
import {
  ScheduledSendSchema,
  UsageStateSchema,
  UsageWindowSchema,
  events,
  methods,
  usageEmpty,
} from '../src/index.js';

// ── v1.3 B: usage limits and scheduled sends ───────────────────────────────

describe('v1.3 usage', () => {
  it('a window has a key, an observed time and optional status, utilization and reset', () => {
    const w = { key: 'five_hour', observedAt: 5, source: 'event' };
    expect(UsageWindowSchema.parse(w)).toEqual(w);
    const full = {
      ...w,
      status: 'allowed_warning',
      utilization: 81,
      resetsAt: 1_800_000_000_000,
      label: 'Fable',
    };
    expect(UsageWindowSchema.parse(full)).toEqual(full);
    expect(UsageWindowSchema.safeParse({ key: 'five_hour' }).success).toBe(false);
  });

  it('an unknown status from a newer service reads as absent, not as an error', () => {
    const w = UsageWindowSchema.parse({
      key: 'five_hour',
      observedAt: 1,
      source: 'event',
      status: 'throttled',
    });
    expect(w.status).toBeUndefined();
  });

  it('the usage state lists windows and the chats refused by a limit', () => {
    const state = {
      windows: [{ key: 'five_hour', observedAt: 1, source: 'usage', utilization: 12 }],
      subscriptionType: 'max',
      rateLimitsAvailable: true,
      refused: [{ sessionId: 's1', at: 3, resetsAt: 9 }],
    };
    expect(UsageStateSchema.parse(state)).toEqual(state);
    expect(UsageStateSchema.parse({})).toEqual(usageEmpty);
  });

  it('usage.get optionally asks for a fresh reading; usage.changed carries the state', () => {
    expect(methods['usage.get'].params.parse({})).toEqual({});
    expect(methods['usage.get'].params.parse({ refresh: true })).toEqual({ refresh: true });
    expect(methods['usage.get'].result.parse({ windows: [], refused: [] })).toEqual(usageEmpty);
    expect(events['usage.changed'].parse({ windows: [], refused: [] })).toEqual(usageEmpty);
  });
});

describe('v1.3 scheduled sends', () => {
  const send = {
    id: 'x1',
    sessionId: 's1',
    text: 'Continue with step 3',
    imageCount: 0,
    sendAt: 10,
    createdAt: 5,
    state: 'pending',
    afterLimitReset: false,
    rescheduled: false,
  };

  it('a scheduled send is listed without its image data', () => {
    expect(ScheduledSendSchema.parse(send)).toEqual(send);
    const failed = { ...send, state: 'failed', error: 'Usage limit reached again', late: true };
    expect(ScheduledSendSchema.parse(failed)).toEqual(failed);
    expect(ScheduledSendSchema.safeParse({ ...send, state: 'later' }).success).toBe(false);
  });

  it('scheduled.create takes a time or "when the limit resets"', () => {
    const p = methods['scheduled.create'].params;
    expect(p.safeParse({ sessionId: 's', text: 'hi', sendAt: 5 }).success).toBe(true);
    expect(p.safeParse({ sessionId: 's', text: 'hi', whenLimitResets: true }).success).toBe(true);
    expect(
      p.safeParse({
        sessionId: 's',
        text: '',
        images: [{ mediaType: 'image/png', data: 'AA==' }],
        sendAt: 5,
      }).success,
    ).toBe(true);
    expect(p.safeParse({ sessionId: 's', text: 'hi' }).success).toBe(false);
    expect(methods['scheduled.create'].result.parse(send)).toEqual(send);
  });

  it('list, get, update, cancel and send now', () => {
    expect(methods['scheduled.list'].params.parse({})).toEqual({});
    expect(methods['scheduled.list'].params.parse({ sessionId: 's' })).toEqual({ sessionId: 's' });
    expect(methods['scheduled.list'].result.parse({ items: [send] })).toEqual({ items: [send] });
    const full = { ...send, images: [{ mediaType: 'image/png', data: 'AA==' }] };
    expect(methods['scheduled.get'].result.parse(full)).toEqual(full);
    const u = methods['scheduled.update'].params;
    expect(u.safeParse({ id: 'x1', text: 'new' }).success).toBe(true);
    expect(u.safeParse({ id: 'x1', sendAt: 9 }).success).toBe(true);
    expect(u.safeParse({ id: 'x1', whenLimitResets: true }).success).toBe(true);
    expect(methods['scheduled.cancel'].params.safeParse({ id: 'x1' }).success).toBe(true);
    expect(methods['scheduled.sendNow'].params.safeParse({ id: 'x1' }).success).toBe(true);
  });

  it('scheduled.changed carries every listed send; scheduledSent names the chat', () => {
    expect(events['scheduled.changed'].parse({ items: [send] })).toEqual({ items: [send] });
    const sent = {
      sessionId: 's1',
      title: 'Fix the build',
      projectName: 'Threadgarden',
      late: true,
      dueAt: 10,
    };
    expect(events.scheduledSent.parse(sent)).toEqual(sent);
  });
});

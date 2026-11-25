import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CRON_MAX_MS, ScheduleTracker, WAKE_GRACE_MS } from '../../src/chat/schedule.js';

const MIN = 60_000;

const toolUse = (id: string, name: string, input: unknown): SDKMessage =>
  ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
  }) as never;

const toolResult = (id: string, out: unknown, isError = false): SDKMessage =>
  ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }],
    },
    parent_tool_use_id: null,
    tool_use_result: out,
  }) as never;

const setup = () => {
  let now = 1_000_000;
  const t = new ScheduleTracker(() => now);
  return { t, advance: (ms: number) => (now += ms), now: () => now };
};

describe('ScheduleTracker', () => {
  it('a wake-up is pending until its time plus the grace', () => {
    const { t, advance, now } = setup();
    expect(t.pending).toBe(false);
    t.apply(toolUse('w1', 'ScheduleWakeup', { delaySeconds: 1200, prompt: '/loop x' }));
    expect(t.pending).toBe(true);
    t.apply(toolResult('w1', { scheduledFor: now() + 20 * MIN, clampedDelaySeconds: 1200 }));
    advance(20 * MIN + WAKE_GRACE_MS - 1);
    expect(t.pending).toBe(true);
    advance(1);
    expect(t.pending).toBe(false);
  });

  it('the call alone counts, with the delay clamped to an hour', () => {
    const { t, advance } = setup();
    t.apply(toolUse('w1', 'ScheduleWakeup', { delaySeconds: 99_999 }));
    advance(60 * MIN + WAKE_GRACE_MS - 1);
    expect(t.pending).toBe(true);
    advance(1);
    expect(t.pending).toBe(false);
  });

  it('stop ends a wake-up', () => {
    const { t } = setup();
    t.apply(toolUse('w1', 'ScheduleWakeup', { delaySeconds: 600 }));
    t.apply(toolUse('w2', 'ScheduleWakeup', { stop: true }));
    t.apply(toolResult('w2', { stopped: true, cancelledWakeups: 1 }));
    expect(t.pending).toBe(false);
  });

  it('a failed wake-up call keeps nothing new from its answer', () => {
    const { t, now } = setup();
    t.apply(toolUse('w1', 'ScheduleWakeup', { stop: true }));
    t.apply(toolResult('w1', { scheduledFor: now() + 10 * MIN }, true));
    expect(t.pending).toBe(false);
  });

  it('a recurring job holds until deleted', () => {
    const { t, advance } = setup();
    t.apply(toolUse('c1', 'CronCreate', { cron: '*/15 * * * *', prompt: 'check' }));
    expect(t.pending).toBe(false);
    t.apply(toolResult('c1', { id: 'job-1', humanSchedule: 'every 15 min', recurring: true }));
    advance(3 * 24 * 60 * MIN);
    expect(t.pending).toBe(true);
    t.apply(toolUse('d1', 'CronDelete', { id: 'job-1' }));
    t.apply(toolResult('d1', { id: 'job-1' }));
    expect(t.pending).toBe(false);
  });

  it('a recurring job ends after 7 days', () => {
    const { t, advance } = setup();
    t.apply(toolUse('c1', 'CronCreate', { cron: '0 * * * *', prompt: 'p' }));
    t.apply(toolResult('c1', { id: 'job-1', humanSchedule: 'hourly', recurring: true }));
    advance(CRON_MAX_MS - 1);
    expect(t.pending).toBe(true);
    advance(1);
    expect(t.pending).toBe(false);
  });

  it('a one-shot job ends after it fires', () => {
    const { t, advance, now } = setup();
    t.apply(toolUse('c1', 'CronCreate', { cron: '30 14 * * *', prompt: 'p', recurring: false }));
    t.apply(
      toolResult('c1', {
        id: 'job-1',
        humanSchedule: 'at 14:30',
        recurring: false,
        nextFireAt: now() + 30 * MIN,
      }),
    );
    advance(30 * MIN + WAKE_GRACE_MS - 1);
    expect(t.pending).toBe(true);
    advance(1);
    expect(t.pending).toBe(false);
  });

  it('other tools and clear', () => {
    const { t } = setup();
    t.apply(toolUse('x1', 'Bash', { command: 'ls' }));
    t.apply(toolResult('x1', { id: 'job-x', recurring: true }));
    expect(t.pending).toBe(false);
    t.apply(toolUse('w1', 'ScheduleWakeup', { delaySeconds: 600 }));
    t.clear();
    expect(t.pending).toBe(false);
  });
});

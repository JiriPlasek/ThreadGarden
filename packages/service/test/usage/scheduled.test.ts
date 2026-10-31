import { LIMIT_RESET_MARGIN_MS, type EventMsg, type ImageRef } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/history/db.js';
import {
  CHAT_STOPPED,
  LIMIT_RESET_UNKNOWN,
  LIMIT_STILL_REACHED,
  MAX_TIMER_MS,
  STOPPED_WHILE_SENDING,
  ScheduledSends,
} from '../../src/usage/scheduled.js';

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const MIN = 60_000;
const IMG: ImageRef = { mediaType: 'image/png', data: 'AA==' };

describe('ScheduledSends', () => {
  let db: Db;
  let events: EventMsg[];
  let sent: { sessionId: string; text: string; images: ImageRef[] }[];
  let busy: Set<string>;
  let reset: number | undefined;
  let sendError: Error | undefined;
  let late: { sessionId: string; dueAt: number }[];
  let errors: unknown[];

  const make = () =>
    new ScheduledSends({
      raw: db.raw,
      now: () => Date.now(),
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      },
      emit: (e) => events.push(e),
      send: async (sessionId, text, images) => {
        if (sendError) throw sendError;
        sent.push({ sessionId, text, images });
      },
      busy: (id) => busy.has(id),
      limitResetAt: () => (reset !== undefined && reset > Date.now() ? reset : undefined),
      exists: (id) => id !== 'nope',
      describe: (id) => ({ title: `Chat ${id}`, projectName: 'Threadgarden' }),
      noteLate: (sessionId, dueAt) => late.push({ sessionId, dueAt }),
      onError: (err) => errors.push(err),
    });

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const sentEvents = () => events.filter((e) => e.event === 'scheduledSent').map((e) => e.data);

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    db = openDb(':memory:');
    events = [];
    sent = [];
    busy = new Set();
    reset = undefined;
    sendError = undefined;
    late = [];
    errors = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('sends at its time, through chat.send, and announces it', async () => {
    const s = make();
    s.start();
    const item = s.create({ sessionId: 'a', text: 'Go on', images: [IMG], sendAt: T0 + 5 * MIN });
    expect(item).toMatchObject({ state: 'pending', imageCount: 1, sendAt: T0 + 5 * MIN });
    expect(s.pendingCount()).toBe(1);
    await tick(5 * MIN - 1);
    expect(sent).toEqual([]);
    await tick(1);
    expect(sent).toEqual([{ sessionId: 'a', text: 'Go on', images: [IMG] }]);
    expect(s.list('a')[0]?.state).toBe('sending');
    expect(sentEvents()).toEqual([
      { sessionId: 'a', title: 'Chat a', projectName: 'Threadgarden', late: false, dueAt: T0 + 5 * MIN },
    ]);
    s.turnEnded('a', false);
    expect(s.list()).toEqual([]);
    expect(s.pendingCount()).toBe(0);
    const last = events.filter((e) => e.event === 'scheduled.changed').at(-1);
    expect(last?.data).toEqual({ items: [] });
  });

  it('a chat gets its sends in order, one per turn', async () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'second', sendAt: T0 + 2 * MIN });
    s.create({ sessionId: 'a', text: 'first', sendAt: T0 + MIN });
    s.create({ sessionId: 'b', text: 'other chat', sendAt: T0 + 2 * MIN });
    await tick(2 * MIN);
    expect(sent.map((x) => x.text)).toEqual(['first', 'other chat']);
    s.turnEnded('a', false);
    await tick(0);
    expect(sent.map((x) => x.text)).toEqual(['first', 'other chat', 'second']);
  });

  it('waits while the chat is in a turn, and goes when it is idle', async () => {
    const s = make();
    s.start();
    busy.add('a');
    s.create({ sessionId: 'a', text: 'later', sendAt: T0 + MIN });
    await tick(10 * MIN);
    expect(sent).toEqual([]);
    busy.delete('a');
    s.statusChanged('a', 'idle');
    await tick(0);
    expect(sent.map((x) => x.text)).toEqual(['later']);
  });

  it('while the limit is known to refuse, a due send moves to the reset plus a margin', async () => {
    const s = make();
    s.start();
    reset = T0 + 30 * MIN;
    s.create({ sessionId: 'a', text: 'hi', sendAt: T0 + MIN });
    await tick(MIN);
    expect(sent).toEqual([]);
    expect(s.list()[0]).toMatchObject({
      sendAt: reset + LIMIT_RESET_MARGIN_MS,
      afterLimitReset: true,
      rescheduled: false,
    });
    await tick(29 * MIN + LIMIT_RESET_MARGIN_MS);
    expect(sent.map((x) => x.text)).toEqual(['hi']);
  });

  it('"when the limit resets" needs a known reset time', () => {
    const s = make();
    expect(() => s.create({ sessionId: 'a', text: 'hi', whenLimitResets: true })).toThrow(
      expect.objectContaining({ code: 'NO_RESET_TIME' }),
    );
    reset = T0 + 10 * MIN;
    expect(s.create({ sessionId: 'a', text: 'hi', whenLimitResets: true })).toMatchObject({
      sendAt: reset + LIMIT_RESET_MARGIN_MS,
      afterLimitReset: true,
    });
  });

  it('refuses unknown chats and empty messages', () => {
    const s = make();
    expect(() => s.create({ sessionId: 'nope', text: 'x', sendAt: T0 })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => s.create({ sessionId: 'a', text: '  ', sendAt: T0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    );
    expect(s.create({ sessionId: 'a', text: '', images: [IMG], sendAt: T0 + MIN }).imageCount).toBe(
      1,
    );
  });

  it('a send the limit still refuses moves to the new reset once, then fails', async () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'hi', sendAt: T0 + MIN });
    await tick(MIN);
    expect(sent).toHaveLength(1);
    reset = T0 + 60 * MIN;
    s.turnEnded('a', true);
    expect(s.list()[0]).toMatchObject({
      state: 'pending',
      rescheduled: true,
      sendAt: reset + LIMIT_RESET_MARGIN_MS,
    });
    // The limit was lifted early as far as Threadgarden knows; at the new time it goes again.
    reset = undefined;
    await tick(59 * MIN + LIMIT_RESET_MARGIN_MS);
    expect(sent).toHaveLength(2);
    reset = Date.now() + 60 * MIN;
    s.turnEnded('a', true);
    expect(s.list()[0]).toMatchObject({ state: 'failed', error: LIMIT_STILL_REACHED });
    expect(s.pendingCount()).toBe(0);
  });

  it('a refusal without a known reset time fails at once', async () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'hi', sendAt: T0 });
    await tick(0);
    s.turnEnded('a', true);
    expect(s.list()[0]).toMatchObject({ state: 'failed', error: LIMIT_RESET_UNKNOWN });
  });

  it('a send that cannot go out fails with the reason; Send now retries it', async () => {
    const s = make();
    s.start();
    sendError = new Error('Claude Code is not installed');
    s.create({ sessionId: 'a', text: 'hi', sendAt: T0 + MIN });
    await tick(MIN);
    expect(s.list()[0]).toMatchObject({ state: 'failed', error: 'Claude Code is not installed' });
    await tick(10 * MIN);
    expect(sent).toEqual([]); // failed sends wait for the user
    sendError = undefined;
    await s.sendNow(s.list()[0]!.id);
    expect(sent.map((x) => x.text)).toEqual(['hi']);
    expect(s.list()[0]).toMatchObject({ state: 'sending' });
    expect(s.list()[0]!.error).toBeUndefined();
  });

  it('Send now goes out even while the limit is known to refuse, and reports failures', async () => {
    const s = make();
    s.start();
    reset = T0 + 30 * MIN;
    const item = s.create({ sessionId: 'a', text: 'now please', sendAt: T0 + 20 * MIN });
    await s.sendNow(item.id);
    expect(sent.map((x) => x.text)).toEqual(['now please']);
    const other = s.create({ sessionId: 'b', text: 'x', sendAt: T0 + 20 * MIN });
    sendError = new Error('blocked');
    await expect(s.sendNow(other.id)).rejects.toThrow('blocked');
    await expect(s.sendNow('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a chat that stops mid-turn fails its send; one that is ended counts it as sent', async () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'one', sendAt: T0 });
    s.create({ sessionId: 'b', text: 'two', sendAt: T0 });
    await tick(0);
    s.statusChanged('a', 'failed');
    s.statusChanged('b', 'history');
    expect(s.list()).toEqual([
      expect.objectContaining({ sessionId: 'a', state: 'failed', error: CHAT_STOPPED }),
    ]);
  });

  it('cancel and edit', async () => {
    const s = make();
    s.start();
    const a = s.create({ sessionId: 'a', text: 'old', sendAt: T0 + MIN });
    const edited = s.update({ id: a.id, text: 'new', images: [IMG] });
    expect(edited).toMatchObject({ text: 'new', imageCount: 1, sendAt: T0 + MIN });
    expect(s.get(a.id).images).toEqual([IMG]);
    const moved = s.update({ id: a.id, sendAt: T0 + 10 * MIN });
    expect(moved.sendAt).toBe(T0 + 10 * MIN);
    await tick(MIN);
    expect(sent).toEqual([]);
    s.cancel(a.id);
    expect(s.list()).toEqual([]);
    await tick(10 * MIN);
    expect(sent).toEqual([]);
    expect(() => s.cancel(a.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('a new time gives a failed send a fresh start', async () => {
    const s = make();
    s.start();
    sendError = new Error('nope');
    const a = s.create({ sessionId: 'a', text: 'x', sendAt: T0 });
    await tick(0);
    expect(s.list()[0]?.state).toBe('failed');
    sendError = undefined;
    expect(s.update({ id: a.id, sendAt: T0 + MIN })).toMatchObject({
      state: 'pending',
      rescheduled: false,
    });
    await tick(MIN);
    expect(sent).toHaveLength(1);
  });

  it('survives a restart: sends due meanwhile go out late, one going out is not repeated', async () => {
    const first = make();
    first.start();
    first.create({ sessionId: 'a', text: 'overdue', sendAt: T0 + MIN });
    first.create({ sessionId: 'b', text: 'in flight', sendAt: T0 });
    first.create({ sessionId: 'c', text: 'future', sendAt: T0 + 3 * 60 * MIN });
    await tick(0); // b goes out, then the service stops
    first.dispose();
    expect(sent.map((x) => x.text)).toEqual(['in flight']);
    vi.setSystemTime(T0 + 30 * MIN); // the service was not running meanwhile
    events = [];
    const again = make();
    again.start();
    await tick(0);
    expect(sent.map((x) => x.text)).toEqual(['in flight', 'overdue']);
    expect(late).toEqual([{ sessionId: 'a', dueAt: T0 + MIN }]);
    expect(sentEvents()).toEqual([expect.objectContaining({ sessionId: 'a', late: true })]);
    expect(again.list('b')[0]).toMatchObject({ state: 'failed', error: STOPPED_WHILE_SENDING });
    expect(again.list('c')[0]).toMatchObject({ state: 'pending' });
    expect(again.list('c')[0]!.late).toBeUndefined();
  });

  it('long waits re-check at least hourly (sleep and clock changes)', async () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'next week', sendAt: T0 + 7 * 24 * 60 * MIN });
    expect(vi.getTimerCount()).toBe(1);
    await tick(MAX_TIMER_MS);
    expect(vi.getTimerCount()).toBe(1);
    expect(sent).toEqual([]);
  });

  it('dispose stops the timer', () => {
    const s = make();
    s.start();
    s.create({ sessionId: 'a', text: 'x', sendAt: T0 + MIN });
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  });
});

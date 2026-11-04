import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventMsg } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWAY_LINK_TIMEOUT_MS,
  AwayDeliverer,
  DeviceRefused,
  UNREADABLE_MESSAGE,
  type Link,
} from '../../src/away/deliverer.js';
import { AwayQueue } from '../../src/away/queue.js';
import { openDb } from '../../src/history/db.js';
import { LinkError, RemoteError } from '../../src/machine/link.js';

const db = openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-away-')), 'db'));

const SESSION = '0b6c3f4e-8f0a-4c56-9a1e-2f1d1c0b7a11';
const OTHER = '6f1e2d3c-4b5a-4968-8776-655443322110';

type Call = { method: string; params: Record<string, unknown> };

/**
 * One paired machine, `m-1`, as the deliverer sees it: its token, whether it
 * answers (`up`), what it answers each request, its plug and its switch.
 * `m-2` is paired too, with the same token, for the tests with two machines.
 */
const setup = (o: { token?: string | null; power?: boolean } = {}) => {
  db.raw.exec('DELETE FROM away_queue');
  const calls: Call[] = [];
  const closed: number[] = [];
  const machine = {
    token: o.token === undefined ? 'tok' : o.token,
    up: false,
    answer: (async () => ({ queued: false })) as (c: Call) => Promise<unknown>,
  };
  const plug = { on: false as boolean | null, watts: null as number | null };
  const events: EventMsg[] = [];
  const warnings: string[] = [];
  const connect = vi.fn<(machineId: string) => Promise<Link | null>>(async () => {
    if (!machine.up) return null;
    const n = closed.length;
    return {
      request: (method, params) => {
        const call = { method, params: params as Record<string, unknown> };
        calls.push(call);
        return machine.answer(call);
      },
      close: () => void closed.push(n),
    };
  });
  const power = {
    list: () => (o.power === false ? [] : [{ machineId: 'm-1', config: { offWatts: 5 } }]),
    reading: vi.fn(async () => ({ ...plug, at: Date.now() })),
    turnOn: vi.fn(async () => ({ cycled: false, waitMs: 0 })),
  };
  const queue = new AwayQueue(db.raw, () => Date.now());
  const deliverer = new AwayDeliverer({
    queue,
    machines: {
      get: (id) => (id === 'm-1' || id === 'm-2' ? { id } : null),
      token: (id) => (id === 'm-1' || id === 'm-2' ? machine.token : null),
    },
    power,
    connect,
    emit: (e) => events.push(e),
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    log: { warn: (m) => warnings.push(m) },
  });
  return { calls, closed, machine, plug, events, warnings, connect, power, queue, deliverer };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the deliverer's next tick (and the promises it awaits) run. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('the away deliverer', () => {
  it('queued rows go out in order once connected and leave the queue', async () => {
    const t = setup();
    t.machine.up = true;
    const first = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'create',
      text: 'first',
      cwd: '/work',
      model: 'opus',
    });
    const second = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: OTHER,
      kind: 'send',
      text: 'second',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
    const third = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'third',
    });
    expect(first).toMatchObject({ kind: 'create', state: 'waiting', cwd: '/work', imageCount: 0 });
    expect(second).toMatchObject({ kind: 'send', state: 'waiting', cwd: null, imageCount: 1 });
    await settle();
    expect(t.calls).toEqual([
      {
        method: 'chat.create',
        params: { sessionId: SESSION, cwd: '/work', text: 'first', model: 'opus' },
      },
      {
        method: 'chat.send',
        params: {
          sessionId: OTHER,
          text: 'second',
          images: [{ mediaType: 'image/png', data: 'AAAA' }],
          messageId: second.id,
        },
      },
      {
        method: 'chat.send',
        params: { sessionId: SESSION, text: 'third', messageId: third.id },
      },
    ]);
    expect(t.deliverer.list().items).toEqual([]);
    expect(t.events.at(-1)).toEqual({ event: 'away.changed', data: { items: [], states: [] } });
    // The round's own link, closed when it ends.
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.closed).toHaveLength(1);
    // Nothing waits: no more ticks.
    await settle(60_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("a clock set back doesn't reorder a chat's messages", async () => {
    const t = setup();
    t.machine.up = true;
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'first' });
    vi.setSystemTime(Date.now() - 10 * 60_000);
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'second' });
    expect(t.deliverer.list().items.map((i) => i.text)).toEqual(['first', 'second']);
    await settle();
    expect(t.calls.map((c) => c.params.text)).toEqual(['first', 'second']);
  });

  it('a lost answer is retried with the same messageId', async () => {
    const t = setup();
    t.machine.up = true;
    // The machine takes the message, and the link drops before its answer arrives.
    t.machine.answer = async () => {
      throw new LinkError('unreachable', 'closed during chat.send');
    };
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'hello',
    });
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.deliverer.list().items).toMatchObject([
      { id: item.id, state: 'waiting', error: null },
    ]);
    expect(t.closed).toHaveLength(1);
    t.machine.answer = async () => ({ queued: false });
    await settle(5_000);
    expect(t.calls.map((c) => c.params.messageId)).toEqual([item.id, item.id]);
    expect(t.deliverer.list().items).toEqual([]);
  });

  it('a refusal from the machine fails the row and keeps it', async () => {
    const t = setup();
    t.machine.up = true;
    // The chat was moved meanwhile: the machine says where, and the row is never redirected.
    t.machine.answer = async (c) => {
      if (c.params.sessionId === SESSION)
        throw new RemoteError('MOVED', 'This chat is on Laptop now');
      return { queued: false };
    };
    const refused = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'one',
    });
    const behind = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'two',
    });
    t.deliverer.queue({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'elsewhere' });
    await settle();
    const failed = { state: 'failed', reason: 'refused', error: 'This chat is on Laptop now' };
    // The chat's later message is not sent past the refused one: it fails with it, in order.
    expect(t.deliverer.list().items).toMatchObject([
      { id: refused.id, ...failed },
      { id: behind.id, ...failed },
    ]);
    expect(t.calls.map((c) => c.params.text)).toEqual(['one', 'elsewhere']);
    // Kept, and not tried again by itself.
    await settle(60_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.deliverer.list().items).toHaveLength(2);
  });

  it('an Off machine with power control is turned on once per attempt', async () => {
    const t = setup();
    t.plug.on = false;
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    t.deliverer.queue({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'b' });
    await settle();
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    expect(t.power.turnOn).toHaveBeenCalledWith('m-1');
    expect(t.deliverer.list().states).toEqual([
      { machineId: 'm-1', starting: true, startedAt: 1_000_000 },
    ]);
    // Still booting: tried every tick, never turned on again.
    await settle(60_000);
    expect(t.connect.mock.calls.length).toBeGreaterThan(10);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    // Up: both go out, and the attempt is over.
    t.machine.up = true;
    await settle(5_000);
    expect(t.calls.map((c) => c.params.text)).toEqual(['a', 'b']);
    expect(t.deliverer.list()).toEqual({ items: [], states: [] });
  });

  it('a machine whose plug reads on is not turned on again', async () => {
    const t = setup();
    // Drawing power: booting, or up but not reachable from here. Never cut.
    t.plug.on = true;
    t.plug.watts = 80;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle(60_000);
    // On, with no wattage known: it may be running too.
    t.plug.watts = null;
    await settle(60_000);
    expect(t.power.reading.mock.calls.length).toBeGreaterThan(10);
    expect(t.power.turnOn).not.toHaveBeenCalled();
    expect(t.deliverer.list()).toEqual({
      items: [expect.objectContaining({ id: item.id, state: 'waiting', error: null })],
      states: [{ machineId: 'm-1', starting: false, startedAt: null }],
    });
    // In standby, below offWatts: that is Off, and it is turned on.
    t.plug.watts = 2;
    await settle(5_000);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
  });

  it('a start that runs 5 minutes awake fails with reason start and Retry starts again', async () => {
    const t = setup();
    t.plug.on = false;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle();
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    await settle(4 * 60_000 + 55_000);
    expect(t.deliverer.list().items).toMatchObject([{ id: item.id, state: 'waiting' }]);
    await settle(5_000);
    expect(t.deliverer.list()).toEqual({
      items: [
        expect.objectContaining({ id: item.id, state: 'failed', reason: 'start', error: null }),
      ],
      states: [{ machineId: 'm-1', starting: false, startedAt: null }],
    });
    // It waits for Retry: a PC that won't boot is not cycled on every tick.
    const connects = t.connect.mock.calls.length;
    await settle(10 * 60_000);
    expect(t.connect.mock.calls.length).toBe(connects);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    t.deliverer.retry('m-1');
    await settle();
    expect(t.power.turnOn).toHaveBeenCalledTimes(2);
    expect(t.deliverer.list()).toEqual({
      items: [expect.objectContaining({ id: item.id, state: 'waiting', reason: null })],
      states: [{ machineId: 'm-1', starting: true, startedAt: Date.now() }],
    });
  });

  it('a start interrupted by sleep starts again on wake', async () => {
    const t = setup();
    t.plug.on = false;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle(60_000);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    // The lid closes for an hour: no tick runs, the clock moves on.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    // The plug was cut meanwhile (or the boot never began): Off again.
    await settle(5_000);
    // The interrupted start counted as not tried: no failure, a new attempt from now.
    expect(t.power.turnOn).toHaveBeenCalledTimes(2);
    expect(t.deliverer.list()).toEqual({
      items: [expect.objectContaining({ id: item.id, state: 'waiting', reason: null })],
      states: [{ machineId: 'm-1', starting: true, startedAt: Date.now() }],
    });
  });

  it('a sleep while a connect hangs restarts the start instead of failing it', async () => {
    const t = setup();
    t.plug.on = false;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle(60_000);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    // The next round's connect is under way when the lid closes for an hour.
    let gaveUp!: (link: Link | null) => void;
    t.connect.mockImplementationOnce(() => new Promise((resolve) => (gaveUp = resolve)));
    await settle(5_000);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    // On wake the connect gives up: the start was cut short, not tried.
    gaveUp(null);
    await settle();
    expect(t.deliverer.list()).toEqual({
      items: [expect.objectContaining({ id: item.id, state: 'waiting', reason: null })],
      states: [{ machineId: 'm-1', starting: true, startedAt: Date.now() }],
    });
    expect(t.power.turnOn).toHaveBeenCalledTimes(2);
  });

  it('a sleep while the switch is asked gives the start its window from wake', async () => {
    const t = setup();
    t.plug.on = false;
    let switched!: (v: { cycled: boolean; waitMs: number }) => void;
    t.power.turnOn.mockImplementationOnce(() => new Promise((resolve) => (switched = resolve)));
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    await settle();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    switched({ cycled: false, waitMs: 0 });
    await settle(5_000);
    // Turned on once: the machine is booting now, and is not switched again.
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    expect(t.deliverer.list().states).toEqual([
      { machineId: 'm-1', starting: true, startedAt: Date.now() - 5_000 },
    ]);
    await settle(4 * 60_000);
    expect(t.deliverer.list().items).toMatchObject([{ state: 'waiting' }]);
  });

  it('rows wait for the token and go out after unlock', async () => {
    // The app restarted: the local service has no token until the desktop unlocks it.
    const t = setup({ token: null });
    t.machine.up = true;
    t.plug.on = false;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle(60_000);
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.power.turnOn).not.toHaveBeenCalled();
    expect(t.deliverer.list().items).toMatchObject([
      { id: item.id, state: 'waiting', error: null },
    ]);
    t.machine.token = 'tok';
    t.deliverer.onUnlock('m-1');
    await settle();
    expect(t.calls).toMatchObject([{ method: 'chat.send', params: { messageId: item.id } }]);
    expect(t.deliverer.list().items).toEqual([]);
  });

  it('cancel removes a waiting row and not a sending one', async () => {
    const t = setup();
    t.machine.up = true;
    let answer!: (v: unknown) => void;
    t.machine.answer = () => new Promise((resolve) => (answer = resolve));
    const sending = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    const waiting = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: OTHER,
      kind: 'send',
      text: 'b',
    });
    await settle();
    expect(t.deliverer.list().items).toMatchObject([
      { id: sending.id, state: 'sending' },
      { id: waiting.id, state: 'waiting' },
    ]);
    // Going out already: the machine may have it.
    expect(() => t.deliverer.cancel(sending.id)).toThrow(
      expect.objectContaining({ code: 'ALREADY_SENT' }),
    );
    t.deliverer.cancel(waiting.id);
    expect(t.deliverer.list().items.map((i) => i.id)).toEqual([sending.id]);
    expect(t.events.at(-1)).toMatchObject({
      event: 'away.changed',
      data: { items: [{ id: sending.id }] },
    });
    answer({ queued: false });
    await settle();
    expect(t.calls.map((c) => c.params.text)).toEqual(['a']);
    expect(t.deliverer.list().items).toEqual([]);
    // An unknown id (already delivered) is not an error.
    expect(() => t.deliverer.cancel(sending.id)).not.toThrow();
  });

  it('cancelling the last waiting row ends the start and the ticks', async () => {
    const t = setup();
    t.plug.on = false;
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle();
    expect(t.deliverer.list().states).toMatchObject([{ starting: true }]);
    t.deliverer.cancel(item.id);
    expect(t.deliverer.list()).toEqual({ items: [], states: [] });
    expect(t.events.at(-1)).toEqual({ event: 'away.changed', data: { items: [], states: [] } });
    const connects = t.connect.mock.calls.length;
    await settle(60_000);
    expect(t.connect.mock.calls.length).toBe(connects);
  });

  it('a new message after a failed start starts it again', async () => {
    const t = setup();
    t.plug.on = false;
    const first = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle(5 * 60_000 + 5_000);
    expect(t.deliverer.list().items).toMatchObject([{ state: 'failed', reason: 'start' }]);
    // Writing again asks for the machine again, as Retry does: the failed one goes too.
    const later = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: OTHER,
      kind: 'send',
      text: 'b',
    });
    expect(later).toMatchObject({ state: 'waiting', reason: null });
    await settle();
    expect(t.power.turnOn).toHaveBeenCalledTimes(2);
    expect(t.deliverer.list()).toEqual({
      items: [
        expect.objectContaining({ id: first.id, state: 'waiting', reason: null }),
        expect.objectContaining({ id: later.id, state: 'waiting' }),
      ],
      states: [{ machineId: 'm-1', starting: true, startedAt: Date.now() }],
    });
    t.machine.up = true;
    await settle(5_000);
    expect(t.calls.map((c) => c.params.text)).toEqual(['a', 'b']);
  });

  it('a start-failed row goes once the link opens', async () => {
    const t = setup();
    t.plug.on = false;
    const late = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'late',
    });
    await settle(5 * 60_000 + 5_000);
    expect(t.deliverer.list().items).toMatchObject([{ state: 'failed', reason: 'start' }]);
    // A refused row of another chat waits for an explicit Retry (R9).
    t.queue.fail(
      t.queue.add({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'no' }).id,
      'refused',
      'No such chat',
    );
    // It came up after the window: this desktop's link to it opened.
    t.machine.up = true;
    t.deliverer.onReachable('m-1');
    await settle();
    expect(t.calls.map((c) => c.params.text)).toEqual(['late']);
    expect(t.calls[0]?.params.messageId).toBe(late.id);
    expect(t.deliverer.list().items).toMatchObject([
      { sessionId: OTHER, state: 'failed', reason: 'refused' },
    ]);
  });

  it('a link opening with nothing failed to start changes nothing', async () => {
    const t = setup();
    t.deliverer.onReachable('m-1');
    t.deliverer.onReachable('m-9');
    await settle();
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('the follow-up after a start failure reaches the machine after the original', async () => {
    const t = setup();
    t.plug.on = false;
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'original' });
    await settle(5 * 60_000 + 5_000);
    expect(t.deliverer.list().items).toMatchObject([{ state: 'failed', reason: 'start' }]);
    // The machine is up and the desktop's link open; the follow-up goes through the
    // queue (the chat has a row that isn't refused), so it can't overtake the original.
    t.machine.up = true;
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'follow-up' });
    t.deliverer.onReachable('m-1');
    await settle();
    expect(t.calls.map((c) => c.params.text)).toEqual(['original', 'follow-up']);
    expect(t.deliverer.list().items).toEqual([]);
  });

  it('a new message behind a refused one in its chat fails with it', async () => {
    const t = setup();
    t.machine.up = true;
    t.machine.answer = async () => {
      throw new RemoteError('NOT_FOUND', 'No such chat');
    };
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'c' });
    await settle();
    // The chat keeps its order: the next message is not sent past the refused one.
    const behind = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'd',
    });
    expect(behind).toMatchObject({ state: 'failed', reason: 'refused', error: 'No such chat' });
    // Another chat on the machine is not held up.
    t.machine.answer = async () => ({ queued: false });
    t.deliverer.queue({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'e' });
    await settle();
    expect(t.calls.map((c) => c.params.text)).toEqual(['c', 'e']);
  });

  it('at start, rows left by the last run go out, one left sending with its own id', async () => {
    const t = setup();
    // The last run stopped while one row was going out: the machine may have it.
    const cut = t.queue.add({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    t.queue.claim(cut.id);
    t.queue.add({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'b' });
    // A service started with rows pending: a new attempt starts.
    t.plug.on = false;
    t.deliverer.start();
    expect(t.deliverer.list().items.map((i) => i.state)).toEqual(['waiting', 'waiting']);
    await settle();
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    t.machine.up = true;
    await settle(5_000);
    expect(t.calls).toMatchObject([
      { method: 'chat.send', params: { text: 'a', messageId: cut.id } },
      { method: 'chat.send', params: { text: 'b' } },
    ]);
    expect(t.deliverer.list().items).toEqual([]);
  });

  it('a message that no longer reads back fails instead of going out', async () => {
    const t = setup();
    t.machine.up = true;
    const item = t.queue.add({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    db.raw.prepare("UPDATE away_queue SET payload = '{' WHERE id = ?").run(item.id);
    t.deliverer.start();
    await settle();
    expect(t.calls).toEqual([]);
    expect(t.deliverer.list().items).toMatchObject([
      { id: item.id, state: 'failed', reason: 'refused', error: UNREADABLE_MESSAGE },
    ]);
  });

  it('closing ends a round in flight: its link closes and the row waits for the next run', async () => {
    const t = setup();
    t.machine.up = true;
    let lost!: (err: unknown) => void;
    t.machine.answer = () => new Promise((_, reject) => (lost = reject));
    const item = t.deliverer.queue({
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'send',
      text: 'a',
    });
    await settle();
    expect(t.deliverer.list().items).toMatchObject([{ state: 'sending' }]);
    const closing = t.deliverer.close();
    expect(t.closed).toHaveLength(1);
    // The closed link loses the answer, as a real one does.
    lost(new LinkError('unreachable', 'closed during chat.send'));
    await closing;
    expect(t.deliverer.list().items).toMatchObject([{ id: item.id, state: 'waiting' }]);
    await settle(60_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it('a slow round while awake is not taken for sleep', async () => {
    const t = setup();
    t.plug.on = false;
    // Each connect takes the whole link timeout to give up (a host that never answers).
    t.connect.mockImplementation(
      () =>
        new Promise<Link | null>((resolve) =>
          setTimeout(() => resolve(null), AWAY_LINK_TIMEOUT_MS),
        ),
    );
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    await settle(10 * 60_000);
    expect(t.power.turnOn).toHaveBeenCalledTimes(1);
    expect(t.deliverer.list().items).toMatchObject([{ state: 'failed', reason: 'start' }]);
  });

  it("one machine's failure does not cut another machine's round short", async () => {
    const t = setup();
    t.machine.up = true;
    let answer!: (v: unknown) => void;
    t.machine.answer = () => new Promise((resolve) => (answer = resolve));
    const healthy = t.connect.getMockImplementation()!;
    t.connect.mockImplementation(async (id) => {
      if (id === 'm-2') throw new Error('m-2 broke');
      return healthy(id);
    });
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    t.deliverer.queue({ machineId: 'm-2', sessionId: OTHER, kind: 'send', text: 'b' });
    let ticked = false;
    void t.deliverer.tick().then(() => (ticked = true));
    await settle();
    // m-1's round is still out: the tick is not over, and no second one overlaps it.
    expect(t.deliverer.list('m-1').items).toMatchObject([{ state: 'sending' }]);
    expect(ticked).toBe(false);
    answer({ queued: false });
    await settle();
    expect(ticked).toBe(true);
    expect(t.deliverer.list('m-1').items).toEqual([]);
    expect(t.warnings.join(' ')).toContain('m-2 broke');
  });

  it('a machine that refuses this device fails its rows instead of being started', async () => {
    const t = setup();
    t.plug.on = false;
    const refusal = 'Ubuntu PC refused this device; pair it again';
    // The token was revoked: the machine is up, and says no at the door.
    t.connect.mockImplementation(async () => {
      throw new DeviceRefused(refusal);
    });
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    t.deliverer.queue({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'b' });
    await settle(60_000);
    expect(t.power.turnOn).not.toHaveBeenCalled();
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.deliverer.list()).toEqual({
      items: [
        expect.objectContaining({ state: 'failed', reason: 'refused', error: refusal }),
        expect.objectContaining({ state: 'failed', reason: 'refused', error: refusal }),
      ],
      states: [{ machineId: 'm-1', starting: false, startedAt: null }],
    });

    // Or it lets the link open and closes it on the first call: the row going out fails too.
    t.queue.forget('m-1');
    t.connect.mockReset();
    t.connect.mockImplementation(async () => ({
      request: async () => {
        throw new DeviceRefused(refusal);
      },
      close: () => {},
    }));
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'c' });
    t.deliverer.queue({ machineId: 'm-1', sessionId: OTHER, kind: 'send', text: 'd' });
    await settle(60_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.deliverer.list().items).toMatchObject([
      { state: 'failed', reason: 'refused', error: refusal },
      { state: 'failed', reason: 'refused', error: refusal },
    ]);
  });

  it('a machine without power control is never turned on, and its rows wait', async () => {
    const t = setup({ power: false });
    t.deliverer.queue({ machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'a' });
    await settle(60_000);
    expect(t.power.reading).not.toHaveBeenCalled();
    expect(t.power.turnOn).not.toHaveBeenCalled();
    expect(t.deliverer.list().items).toMatchObject([{ state: 'waiting' }]);
  });
});

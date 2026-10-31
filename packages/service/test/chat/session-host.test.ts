import { describe, expect, it } from 'vitest';
import {
  settingsDefaults,
  type ChatItem,
  type EventMsg,
  type Settings,
} from '@threadgarden/protocol';
import { MAX_SEQ_EPOCH, nextSeqEpoch, seqBaseForEpoch } from '../../src/chat/event-log.js';
import { SessionHost, type SessionHostDeps } from '../../src/chat/session-host.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import {
  ManualTimers,
  MemoryRegistry,
  notification,
  result,
  settle,
  started,
  statuses,
} from './live-helpers.js';

class ThrowingRegistry extends MemoryRegistry {
  override markEnded(sessionId: string): void {
    super.markEnded(sessionId);
    throw new Error('db is locked');
  }
}

/** Collects unhandled promise rejections while `fn` runs (plus a few turns after). */
const watchUnhandled = async (fn: () => Promise<void>): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    await settle();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
};

const MIN = 60_000;

const setup = (over: Partial<SessionHostDeps> = {}) => {
  const adapter = new FakeAdapter();
  const registry = new MemoryRegistry();
  const timers = new ManualTimers();
  const events: EventMsg[] = [];
  const pinned = new Set<string>();
  const settings: Settings = { ...settingsDefaults };
  const host = new SessionHost({
    adapter,
    registry,
    claudePath: () => '/bin/claude',
    env: () => ({ PATH: '/usr/bin' }),
    emit: (e) => events.push(e),
    now: timers.now,
    timers,
    isPinned: (id) => pinned.has(id),
    getSettings: () => settings,
    ...over,
  });
  return { adapter, registry, timers, events, pinned, settings, host };
};

/** Creates a chat and lets its first turn finish, so it is idle from `timers.now()`. */
const idleChat = async (ctx: ReturnType<typeof setup>, cwd = '/proj') => {
  const s = ctx.host.create(cwd, { text: 'hi' });
  const fake = ctx.adapter.lastSession();
  fake.emit(result(`r-${s.sessionId}`));
  await settle();
  expect(s.status).toBe('idle');
  return { s, fake };
};

describe('SessionHost', () => {
  it('creates live chats and tracks them by session id', () => {
    const { host, adapter, registry } = setup();
    const s = host.create('/proj', { text: 'hello' }, { model: 'claude-opus-5-5' });
    expect(host.get(s.sessionId)).toBe(s);
    expect(host.liveCount()).toBe(1);
    expect(registry.live.get(s.sessionId)).toBe('/proj');
    expect(adapter.lastSession().options).toMatchObject({
      claudePath: '/bin/claude',
      env: { PATH: '/usr/bin' },
      model: 'claude-opus-5-5',
      sessionId: s.sessionId,
    });
    expect(host.get('unknown')).toBeUndefined();
  });

  it('reclaimIdle closes idle unpinned sessions after 15 min and sets paused', async () => {
    const ctx = setup();
    const { host, registry, timers, events } = ctx;
    const { s, fake } = await idleChat(ctx);
    const idleAt = timers.now();

    expect(host.reclaimIdle(idleAt + 15 * MIN - 1)).toBe(0);
    expect(s.live).toBe(true);

    expect(host.reclaimIdle(idleAt + 15 * MIN)).toBe(1);
    expect(fake.closed).toBe(true);
    expect(host.get(s.sessionId)?.status).toBe('paused');
    expect(host.liveCount()).toBe(0);
    expect(registry.live.has(s.sessionId)).toBe(false);
    expect(statuses(events, s.sessionId).at(-1)).toBe('paused');
  });

  it('runs reclaim every 60 s once started, using the minutes from settings', async () => {
    const ctx = setup();
    const { host, timers, settings } = ctx;
    settings.idleReclaimMinutes = 2;
    host.start();
    const { s } = await idleChat(ctx);

    timers.advance(1 * MIN - 1);
    expect(s.live).toBe(true);
    timers.advance(1); // first tick: idle 1 min
    expect(s.live).toBe(true);
    timers.advance(1 * MIN); // second tick: idle 2 min
    expect(s.status).toBe('paused');

    host.dispose();
    expect(timers.pending).toBe(0);
  });

  it('never reclaims when idleReclaimMinutes is 0', async () => {
    const ctx = setup();
    ctx.settings.idleReclaimMinutes = 0;
    const { s } = await idleChat(ctx);
    expect(ctx.host.reclaimIdle(ctx.timers.now() + 24 * 60 * MIN)).toBe(0);
    expect(s.live).toBe(true);
  });

  it('list() reports every chat with status, liveness and what it waits for', async () => {
    const ctx = setup();
    const { host, adapter } = ctx;
    const { s: idle } = await idleChat(ctx, '/a');
    const waiting = host.create('/b', { text: 'do it' });
    void adapter.lastSession().requestPermission('Bash', { command: 'x' }, { requestId: 'w1' });
    await settle();
    const byId = new Map(host.list().map((c) => [c.sessionId, c]));
    expect(byId.get(idle.sessionId)).toEqual({
      sessionId: idle.sessionId,
      cwd: '/a',
      status: 'idle',
      live: true,
      lastActivity: ctx.timers.now(),
    });
    expect(byId.get(waiting.sessionId)).toMatchObject({
      cwd: '/b',
      status: 'needsYou',
      live: true,
    });
    expect(byId.get(waiting.sessionId)?.waitingFor).toBeTruthy();
    expect(host.list()).toHaveLength(2);
  });

  it('reclaimIdle never closes a chat whose background tasks are running (R29)', async () => {
    const ctx = setup();
    const { host, timers } = ctx;
    const { s, fake } = await idleChat(ctx);
    fake.emit(started('b1', { task_type: 'local_bash', is_backgrounded: true }));
    await settle();
    timers.advance(33);
    expect(s.runningTasks).toBe(1);
    expect(s.status).toBe('idle');

    expect(host.reclaimIdle(timers.now() + 60 * MIN)).toBe(0);
    expect(s.live).toBe(true);
    expect(fake.closed).toBe(false);

    // Once the last task has ended, the idle chat is reclaimed as usual.
    fake.emit(notification('b1', 'completed'));
    await settle();
    timers.advance(33);
    expect(s.runningTasks).toBe(0);
    expect(host.reclaimIdle(timers.now() + 60 * MIN)).toBe(1);
    expect(fake.closed).toBe(true);
    expect(host.get(s.sessionId)?.status).toBe('paused');
  });

  it('reclaimIdle never closes needsYou or pinned', async () => {
    const ctx = setup();
    const { host, pinned, timers, adapter } = ctx;
    const { s: pinnedChat } = await idleChat(ctx);
    pinned.add(pinnedChat.sessionId);

    const waiting = host.create('/proj', { text: 'do it' });
    const pending = adapter.lastSession().requestPermission(
      'Bash',
      { command: 'x' },
      {
        requestId: 'w1',
      },
    );
    await settle();
    expect(waiting.status).toBe('needsYou');

    const working = host.create('/proj', { text: 'busy' });

    expect(host.reclaimIdle(timers.now() + 60 * MIN)).toBe(0);
    expect(pinnedChat.live).toBe(true);
    expect(waiting.live).toBe(true);
    expect(working.live).toBe(true);

    waiting.respond('w1', { decision: 'allow' });
    await pending;
    host.stopAll();
  });

  it('send to paused session resumes with same sessionId', async () => {
    const ctx = setup();
    const { host, adapter, timers, registry } = ctx;
    const { s } = await idleChat(ctx, '/proj');
    host.reclaimIdle(timers.now() + 15 * MIN);
    const seqBefore = s.seq;

    const resumed = host.ensureLive(s.sessionId, '/proj');
    expect(resumed.sessionId).toBe(s.sessionId);
    expect(resumed.live).toBe(true);
    const fake = adapter.lastSession();
    expect(fake.options.resume).toBe(s.sessionId);
    expect(fake.options.cwd).toBe('/proj');
    expect(registry.live.get(s.sessionId)).toBe('/proj');

    expect(resumed.send({ text: 'and now?' })).toEqual({ queued: false });
    expect(fake.sent).toHaveLength(1);
    expect(host.get(s.sessionId)).toBe(resumed);
    expect(host.liveCount()).toBe(1);
    // Sequence numbers continue across the resume, so a connected client sees no gap.
    expect(resumed.seq).toBeGreaterThan(seqBefore);
    expect(resumed.since(seqBefore)).not.toBe('gap');

    // ensureLive on a live chat is a no-op.
    expect(host.ensureLive(s.sessionId, '/proj')).toBe(resumed);
    expect(adapter.started).toHaveLength(2);
  });

  it('ensureLive resumes a history chat the host has never seen', () => {
    const { host, adapter } = setup();
    const s = host.ensureLive('hist-1', '/old');
    expect(s.sessionId).toBe('hist-1');
    expect(adapter.lastSession().options.resume).toBe('hist-1');
    expect(host.liveCount()).toBe(1);
  });

  it('end closes the session, reports history and forgets it', async () => {
    const ctx = setup();
    const { s, fake } = await idleChat(ctx);
    ctx.host.end(s.sessionId);
    expect(fake.closed).toBe(true);
    expect(statuses(ctx.events, s.sessionId).at(-1)).toBe('history');
    expect(ctx.host.get(s.sessionId)).toBeUndefined();
    expect(ctx.host.liveCount()).toBe(0);
    expect(() => ctx.host.end('unknown')).not.toThrow();
  });

  it('stopAll ends every live session and returns count', async () => {
    const ctx = setup();
    const { host, adapter, timers, registry } = ctx;
    const { s: paused } = await idleChat(ctx);
    host.reclaimIdle(timers.now() + 15 * MIN);
    const a = host.create('/a', { text: 'one' });
    const b = host.create('/b', { text: 'two' });

    expect(host.stopAll()).toBe(2);
    expect(host.liveCount()).toBe(0);
    for (const fake of adapter.started.slice(1)) {
      expect(fake.interrupted).toBe(1);
      expect(fake.closed).toBe(true);
    }
    expect(a.live).toBe(false);
    expect(b.live).toBe(false);
    expect(registry.listLive()).toEqual([]);
    expect(host.get(paused.sessionId)?.status).toBe('paused');
    expect(host.stopAll()).toBe(0);
  });

  it('a failing session leaves the others running and stops counting as live', async () => {
    const { host, adapter } = setup();
    const a = host.create('/a', { text: 'one' });
    const fakeA = adapter.lastSession();
    const b = host.create('/b', { text: 'two' });
    fakeA.end(new Error('boom'));
    await a.whenEnded();
    expect(host.get(a.sessionId)?.status).toBe('failed');
    expect(b.status).toBe('working');
    expect(host.liveCount()).toBe(1);
  });

  it('marks previously-live sessions interrupted on startup', () => {
    const { host, registry, events, adapter } = setup();
    registry.markLive('s1', '/one');
    registry.markLive('s2', '/two');

    expect(host.recoverAfterRestart()).toBe(2);
    for (const id of ['s1', 's2']) {
      const s = host.get(id);
      expect(s?.status).toBe('failed');
      expect(s?.live).toBe(false);
      const items: ChatItem[] = s!.snapshot(10).items;
      expect(items).toEqual([
        expect.objectContaining({
          kind: 'system',
          level: 'error',
          text: 'Interrupted when the Threadgarden service stopped — send a message to resume',
        }),
      ]);
      expect(statuses(events, id)).toEqual(['failed']);
    }
    expect(host.get('s2')?.cwd).toBe('/two');
    expect(registry.listLive()).toEqual([]);
    expect(registry.ended).toEqual(['s1', 's2']);
    expect(host.liveCount()).toBe(0);
    expect(adapter.started).toHaveLength(0);

    const resumed = host.ensureLive('s1', '/one');
    expect(adapter.lastSession().options.resume).toBe('s1');
    expect(resumed.since(0)).not.toBe('gap');
  });

  it('keeps seq monotonic when an ended chat is resumed in the same run', async () => {
    const ctx = setup();
    const { host, events } = ctx;
    const { s } = await idleChat(ctx);
    host.end(s.sessionId);
    const oldSeq = s.seq;
    expect(oldSeq).toBeGreaterThan(1);

    const resumed = host.ensureLive(s.sessionId, '/proj');
    resumed.send({ text: 'back again' });
    expect(resumed.seq).toBeGreaterThan(oldSeq);

    const after = resumed.since(oldSeq);
    expect(after).not.toBe('gap');
    const seqs = (after as { data: { seq: number } }[]).map((e) => e.data.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => oldSeq + 1 + i));
    expect(resumed.since(oldSeq - 1)).toBe('gap'); // the old events are gone, never renumbered
    // Every event this session ever emitted has a strictly increasing seq.
    const emitted = events
      .filter((e) => e.event.startsWith('chat.'))
      .map((e) => (e.data as { seq: number }).seq);
    expect(emitted).toEqual([...emitted].sort((a, b) => a - b));
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('keeps seq monotonic when a chat stopped by stopAll is resumed', () => {
    const { host } = setup();
    const s = host.create('/a', { text: 'one' });
    host.stopAll();
    const oldSeq = s.seq; // includes the final 'history' status event
    const resumed = host.ensureLive(s.sessionId, '/a');
    expect(resumed.seq).toBeGreaterThan(oldSeq);
    expect(resumed.since(oldSeq)).not.toBe('gap');
    expect(resumed.since(0)).toBe('gap');
  });

  it('contains a throwing registry: no unhandled rejection, other chats unaffected', async () => {
    const errors: string[] = [];
    const { host, adapter } = setup({
      registry: new ThrowingRegistry(),
      onError: (_err, context) => errors.push(context),
    });
    const a = host.create('/a', { text: 'one' });
    const fakeA = adapter.lastSession();
    const b = host.create('/b', { text: 'two' });
    const c = host.create('/c', { text: 'three' });

    const unhandled = await watchUnhandled(async () => {
      fakeA.end(new Error('boom'));
      await a.whenEnded();
      expect(() => host.end(c.sessionId)).not.toThrow();
    });

    expect(unhandled).toEqual([]);
    expect(a.status).toBe('failed');
    expect(b.status).toBe('working');
    expect(b.live).toBe(true);
    expect(host.get(c.sessionId)).toBeUndefined();
    expect(c.status).toBe('history');
    expect(errors.filter((e) => e.startsWith('registry.markEnded'))).toHaveLength(2);
  });

  it('contains a throwing getSettings inside the reclaim timer', async () => {
    const errors: string[] = [];
    const ctx = setup({
      getSettings: () => {
        throw new Error('settings unavailable');
      },
      onError: (_err, context) => errors.push(context),
    });
    ctx.host.start();
    const s = ctx.host.create('/a', { text: 'one' });
    expect(() => ctx.timers.advance(3 * MIN)).not.toThrow();
    expect(errors).toEqual(['idle reclaim', 'idle reclaim', 'idle reclaim']);
    expect(s.live).toBe(true);
    ctx.host.dispose();
  });

  it('reclaim continues past a session whose pin lookup throws', async () => {
    const errors: string[] = [];
    let broken = '';
    const ctx = setup({
      isPinned: (id) => {
        if (id === broken) throw new Error('pins unavailable');
        return false;
      },
      onError: (_err, context) => errors.push(context),
    });
    const { s: first } = await idleChat(ctx, '/one');
    const { s: second } = await idleChat(ctx, '/two');
    broken = first.sessionId;
    expect(ctx.host.reclaimIdle(ctx.timers.now() + 15 * MIN)).toBe(1);
    expect(first.live).toBe(true);
    expect(second.status).toBe('paused');
    expect(errors).toEqual([`idle reclaim (session ${first.sessionId})`]);
  });

  it('stopAll continues past a throwing session', () => {
    const errors: string[] = [];
    const { host } = setup({ onError: (_err, context) => errors.push(context) });
    const a = host.create('/a', { text: 'one' });
    const b = host.create('/b', { text: 'two' });
    const c = host.create('/c', { text: 'three' });
    b.end = () => {
      throw new Error('stuck');
    };

    expect(host.stopAll()).toBe(2);
    expect(a.live).toBe(false);
    expect(c.live).toBe(false);
    expect(host.get(b.sessionId)).toBe(b); // not stopped, still tracked
    expect(errors).toEqual([`stop all (session ${b.sessionId})`]);
    b.end = Object.getPrototypeOf(b).end;
    host.end(b.sessionId);
  });

  it('numbers every chat from seqBase, so seqs of another service run are a gap', async () => {
    const base = seqBaseForEpoch(3);
    const ctx = setup({ seqBase: base });
    expect(ctx.host.seqOf('never-seen')).toBe(base);
    expect(ctx.host.since('never-seen', base)).toEqual([]);
    expect(ctx.host.since('never-seen', 5)).toBe('gap');

    const { s } = await idleChat(ctx);
    expect(s.seq).toBeGreaterThan(base);
    const all = ctx.host.since(s.sessionId, base);
    expect(all).not.toBe('gap');
    expect((all as { data: { seq: number } }[])[0]?.data.seq).toBe(base + 1);
    // A seq the previous service run handed out (epoch 2) is never mistaken for one of ours.
    expect(ctx.host.since(s.sessionId, seqBaseForEpoch(2) + 2)).toBe('gap');

    const last = s.seq;
    ctx.host.end(s.sessionId);
    expect(ctx.host.seqOf(s.sessionId)).toBe(last + 1); // the final 'history' status
    expect(ctx.host.since(s.sessionId, last + 1)).toEqual([]);
    expect(ctx.host.since(s.sessionId, last)).toBe('gap');
  });

  it('nextSeqEpoch advances and wraps within the safe-integer range', () => {
    expect(nextSeqEpoch(undefined)).toBe(1);
    expect(nextSeqEpoch('junk')).toBe(1);
    expect(nextSeqEpoch(1)).toBe(2);
    expect(nextSeqEpoch(MAX_SEQ_EPOCH)).toBe(1);
    expect(Number.isSafeInteger(seqBaseForEpoch(MAX_SEQ_EPOCH) + 2 ** 32)).toBe(true);
  });

  // ── v1.1 T2 ─────────────────────────────────────────────────────────────────

  it('hands turn ends and activity to its deps and lists each chat with its last activity', async () => {
    const turns: string[] = [];
    const activity: string[] = [];
    const ctx = setup({
      onTurnEnded: (id) => turns.push(id),
      onActivity: (id) => activity.push(id),
    });
    const { s } = await idleChat(ctx);
    expect(turns).toEqual([s.sessionId]);
    expect(activity.length).toBeGreaterThan(0);
    expect(new Set(activity)).toEqual(new Set([s.sessionId]));
    expect(ctx.host.list()).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, lastActivity: ctx.timers.now() }),
    ]);
    // A resumed chat still reports its turns.
    s.pause();
    const again = ctx.host.ensureLive(s.sessionId, '/proj');
    again.send({ text: 'more' });
    ctx.adapter.lastSession().emit(result('r-again'));
    await settle();
    expect(turns).toEqual([s.sessionId, s.sessionId]);
  });

  it('lists the running tasks of a live chat and reports changes of the count (R29)', async () => {
    const counts: [string, number][] = [];
    const ctx = setup({ onRunningTasks: (id, n) => counts.push([id, n]) });
    const { s, fake } = await idleChat(ctx);
    expect(ctx.host.list()[0]).not.toHaveProperty('runningTasks');
    fake.emit(started('b1', { task_type: 'local_bash', is_backgrounded: true }));
    await settle();
    ctx.timers.advance(33);
    expect(s.status).toBe('idle');
    expect(ctx.host.list()).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, status: 'idle', runningTasks: 1 }),
    ]);
    expect(counts).toEqual([[s.sessionId, 1]]);
    fake.emit(notification('b1', 'completed'));
    await settle();
    ctx.timers.advance(33);
    expect(ctx.host.list()[0]).not.toHaveProperty('runningTasks');
    expect(counts).toEqual([
      [s.sessionId, 1],
      [s.sessionId, 0],
    ]);
  });
});

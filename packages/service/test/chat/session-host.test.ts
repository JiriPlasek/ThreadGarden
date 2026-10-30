import { describe, expect, it } from 'vitest';
import { settingsDefaults, type ChatItem, type EventMsg, type Settings } from '@pahub/protocol';
import { SessionHost, type SessionHostDeps } from '../../src/chat/session-host.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { ManualTimers, MemoryRegistry, result, settle, statuses } from './live-helpers.js';

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
          text: 'Interrupted when the pahub service stopped — send a message to resume',
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
});

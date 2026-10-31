/**
 * v1.2 buckets (design §3) through the real service wiring, a fake Claude
 * Code and a WebSocket client: auto-unarchive, the hold timer and restarts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventMsg } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realTimers, type Timers } from '../../src/chat/live-session.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { END_INDEX_WAIT_MS } from '../../src/server/handlers/chat.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { result } from '../chat/live-helpers.js';
import { TestClient, eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-buckets-'));
});
afterEach(async () => {
  client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

const NOW = 1_800_000_000_000;

const addHistory = (adapter: FakeAdapter, sessionId: string, cwd: string, lastModified: number) => {
  const m = (uuid: string, type: 'user' | 'assistant', text: string) =>
    ({
      type,
      uuid,
      session_id: sessionId,
      message:
        type === 'user'
          ? { role: 'user', content: text }
          : { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    }) as SessionMessage;
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Chat ${sessionId}`, lastModified, fileSize: 100, cwd },
    messages: [m(`${sessionId}-u`, 'user', 'question'), m(`${sessionId}-a`, 'assistant', 'answer')],
  });
};

/** A controllable service clock and its periodic timer. */
type Clock = { now: number; opts: Partial<StartOptions>; tick: () => void };
const clock = (): Clock => {
  const ticks: (() => void)[] = [];
  const c: Clock = {
    now: NOW,
    opts: {
      clock: () => c.now,
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    },
    tick: () => {
      for (const t of ticks) t();
    },
  };
  return c;
};

const start = async (adapter: FakeAdapter, over: Partial<StartOptions> = {}) => {
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    ...over,
  });
  client = await TestClient.connect(svc.port, svc.token);
  const c = client;
  await eventually(async () => {
    const r = await c.call<Any>('places.counts', {});
    return r.active + r.onHold + r.archived >= adapter.sessions.size;
  });
  return c;
};

const restart = async (adapter: FakeAdapter, over: Partial<StartOptions> = {}) => {
  client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  return start(adapter, over);
};

const summary = async (c: TestClient, id: string): Promise<Any> =>
  (await c.call<Any>('sessions.summaries', { sessionIds: [id] })).items[0];
const changedFor = (id: string) => (e: EventMsg) =>
  e.event === 'sessions.changed' && (e.data as { sessionIds: string[] }).sessionIds.includes(id);

describe('buckets (service)', () => {
  it('archiving a chat pahub runs is refused until it ends; sending to an archived chat brings it back', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    const c = await start(adapter);
    await c.call('chat.send', { sessionId: 'h1', text: 'one' });
    expect(await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' })).toEqual({
      updated: 0,
      skipped: [{ sessionId: 'h1', reason: 'LIVE' }],
    });
    await c.call('chat.end', { sessionId: 'h1' });
    expect(await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' })).toEqual({
      updated: 1,
      skipped: [],
    });
    await c.waitFor(changedFor('h1'));
    expect(await summary(c, 'h1')).toMatchObject({ bucket: 'archived' });
    expect((await c.call<Any>('places.counts', {})).archived).toBe(1);

    const before = c.events.filter(changedFor('h1')).length;
    await c.call('chat.send', { sessionId: 'h1', text: 'two' });
    expect(await summary(c, 'h1')).toMatchObject({ bucket: 'active', live: true });
    expect(c.events.filter(changedFor('h1')).length).toBeGreaterThan(before);
    expect((await c.call<Any>('places.counts', {})).archived).toBe(0);
  });

  it('a new chat ended mid-turn, before it was indexed, can be archived at once', async () => {
    // "End this chat and archive it?": chat.end, then chat.setBucket right away.
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const { sessionId } = await c.call<Any>('chat.create', { cwd: dir, text: 'a long job' });
    // Claude Code has written its transcript, but the turn still runs, so indexing waits.
    addHistory(adapter, sessionId, dir, NOW - 1000);
    expect(await summary(c, sessionId)).toMatchObject({ live: true });
    await c.call('chat.end', { sessionId });
    expect(await c.call('chat.setBucket', { sessionIds: [sessionId], bucket: 'archived' })).toEqual(
      { updated: 1, skipped: [] },
    );
    expect(await summary(c, sessionId)).toMatchObject({ live: false, bucket: 'archived' });
  });

  it('chat.end waits for the index at most END_INDEX_WAIT_MS, and leaves no timer behind', async () => {
    const adapter = new FakeAdapter();
    // Node timers, except the cap, which the test fires (or sees cleared) itself.
    type Cap = { fire: () => void; cleared: boolean };
    const caps: Cap[] = [];
    const timers: Timers = {
      ...realTimers,
      setTimeout: (fn, ms) => {
        if (ms !== END_INDEX_WAIT_MS) return realTimers.setTimeout(fn, ms);
        const cap = { fire: fn, cleared: false };
        caps.push(cap);
        return cap;
      },
      clearTimeout: (h) => {
        const cap = caps.find((c) => c === h);
        if (cap) cap.cleared = true;
        else realTimers.clearTimeout(h);
      },
    };
    // A busy index queue (a first-run full sync): the ended chat's refresh hangs.
    let hang = false;
    let release: (() => void) | undefined;
    const info = adapter.getSessionInfo.bind(adapter);
    adapter.getSessionInfo = (id) =>
      hang ? new Promise((r) => (release = () => r(undefined))) : info(id);
    const c = await start(adapter, { sessionTimers: timers });

    // Indexed in time: the answer comes at once and the cap is cleared.
    const a = (await c.call<Any>('chat.create', { cwd: dir, text: 'first' })).sessionId as string;
    addHistory(adapter, a, dir, NOW - 2000);
    await c.call('chat.end', { sessionId: a });
    expect(caps).toHaveLength(1);
    expect(caps[0]!.cleared).toBe(true);

    // Indexing hangs: the cap answers.
    const b = (await c.call<Any>('chat.create', { cwd: dir, text: 'second' })).sessionId as string;
    addHistory(adapter, b, dir, NOW - 1000);
    hang = true;
    let answered = false;
    const ended = c.call('chat.end', { sessionId: b }).then(() => (answered = true));
    await eventually(() => caps.length === 2 && release !== undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    caps[1]!.fire();
    await ended;
    expect(answered).toBe(true);
    expect(caps[1]!.cleared).toBe(true);
    release!(); // the queue moves on (and the service can close)
  });

  it('a chat sent a message is back in the main quick-search results', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    const c = await start(adapter);
    const hit = async (): Promise<Any | undefined> =>
      (await c.call<Any>('search.quick', { query: 'Chat h1', limit: 10 })).items.find(
        (h: Any) => h.sessionId === 'h1',
      );
    await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' });
    expect(await hit()).toMatchObject({ archived: true });
    await c.call('chat.send', { sessionId: 'h1', text: 'one more thing' });
    const back = await hit();
    expect(back).toBeDefined();
    expect(back).not.toHaveProperty('archived');
  });

  it('Ruling R36: sending a message to a chat on hold ends the hold', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    const t = clock();
    const c = await start(adapter, t.opts);
    await c.call('chat.setBucket', {
      sessionIds: ['h1'],
      bucket: 'onHold',
      holdUntil: NOW + 3_600_000,
      holdNote: 'Monday',
    });
    expect((await c.call<Any>('places.counts', {})).onHold).toBe(1);
    await c.call('chat.send', { sessionId: 'h1', text: 'actually, one more thing' });
    const s = await summary(c, 'h1');
    expect(s).toMatchObject({ bucket: 'active', backFromHold: false });
    expect(s).not.toHaveProperty('holdUntil');
    expect(s).not.toHaveProperty('holdNote');
    expect((await c.call<Any>('places.counts', {})).onHold).toBe(0);
    // The hold's time passing later announces nothing.
    t.now = NOW + 7_200_000;
    t.tick();
    await c.call('places.counts', {});
    expect(c.events.some((e) => e.event === 'chatBackFromHold')).toBe(false);
  });

  it('a chat resumed for a message that then fails to send is not left archived', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    const start0 = adapter.start.bind(adapter);
    adapter.start = (o) => {
      const s = start0(o);
      s.send = () => {
        throw new Error('stdin closed');
      };
      return s;
    };
    const c = await start(adapter);
    await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' });
    const r = await c.raw('chat.send', { sessionId: 'h1', text: 'hello' });
    expect(r.error?.code).toBe('INTERNAL');
    expect(await summary(c, 'h1')).toMatchObject({ live: true, bucket: 'active' });
  });

  it('an archived chat that starts running outside pahub returns to Active', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    let agents = '[]';
    const c = await start(adapter, { externalRun: async () => agents });
    await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' });
    expect(await summary(c, 'h1')).toMatchObject({ bucket: 'archived' });
    agents = JSON.stringify([
      { sessionId: 'h1', cwd: dir, kind: 'interactive', status: 'busy', pid: 4242, startedAt: NOW },
    ]);
    // Poll now (a hidden → visible window polls at once).
    await c.call('ui.visibility', { visible: false });
    await c.call('ui.visibility', { visible: true });
    await eventually(async () => (await summary(c, 'h1')).bucket === 'active');
    expect(await summary(c, 'h1')).toMatchObject({ status: 'working', bucket: 'active' });
  });

  it('a hold that runs out is announced once, listed under Needs you and cleared by markSeen', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    addHistory(adapter, 'h2', dir, NOW - 2000);
    const t = clock();
    const c = await start(adapter, t.opts);
    await c.call('chat.setBucket', {
      sessionIds: ['h1'],
      bucket: 'onHold',
      holdUntil: NOW + 60_000,
      holdNote: 'waiting for review from Petr',
    });
    expect(await summary(c, 'h1')).toMatchObject({
      bucket: 'onHold',
      holdUntil: NOW + 60_000,
      holdNote: 'waiting for review from Petr',
      backFromHold: false,
    });
    expect(await c.call<Any>('places.counts', {})).toMatchObject({ onHold: 1, needsYou: 0 });

    t.now = NOW + 30_000;
    t.tick();
    expect(c.events.some((e) => e.event === 'chatBackFromHold')).toBe(false);

    t.now = NOW + 61_000;
    t.tick();
    const back = await c.waitFor((e) => e.event === 'chatBackFromHold');
    expect(back.data).toEqual({
      sessionId: 'h1',
      title: 'Chat h1',
      projectName: expect.any(String),
    });
    await c.waitFor(changedFor('h1'));
    expect(await summary(c, 'h1')).toMatchObject({ bucket: 'active', backFromHold: true });
    const needsYou = await c.call<Any>('sessions.list', { place: { kind: 'needsYou' }, limit: 10 });
    expect(needsYou.items.map((i: Any) => i.sessionId)).toEqual(['h1']);
    expect(await c.call<Any>('places.counts', {})).toMatchObject({ onHold: 0, needsYou: 1 });

    t.tick(); // once only
    await c.call('places.counts', {});
    expect(c.events.filter((e) => e.event === 'chatBackFromHold')).toHaveLength(1);

    const before = c.events.filter(changedFor('h1')).length;
    await c.call('chat.markSeen', { sessionId: 'h1' });
    await eventually(() => c.events.filter(changedFor('h1')).length === before + 1);
    expect(await summary(c, 'h1')).toMatchObject({ bucket: 'active', backFromHold: false });
    expect((await c.call<Any>('places.counts', {})).needsYou).toBe(0);
  });

  it('sending a message clears back from hold', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    const t = clock();
    const c = await start(adapter, t.opts);
    await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'onHold', holdUntil: NOW - 1 });
    expect(await summary(c, 'h1')).toMatchObject({ backFromHold: true });
    await c.call('chat.send', { sessionId: 'h1', text: 'back to it' });
    adapter.lastSession().emit(result('r1'));
    await c.call('chat.end', { sessionId: 'h1' });
    expect(await summary(c, 'h1')).toMatchObject({ backFromHold: false });
  });

  it('buckets survive a restart; holds that ran out meanwhile end at startup', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, NOW - 1000);
    addHistory(adapter, 'h2', dir, NOW - 2000);
    addHistory(adapter, 'h3', dir, NOW - 3000);
    const t = clock();
    let c = await start(adapter, t.opts);
    await c.call('chat.setBucket', { sessionIds: ['h1'], bucket: 'archived' });
    await c.call('chat.setBucket', {
      sessionIds: ['h2'],
      bucket: 'onHold',
      holdUntil: NOW + 3_600_000,
      holdNote: 'tomorrow',
    });
    await c.call('chat.setBucket', { sessionIds: ['h3'], bucket: 'onHold' });

    t.now = NOW + 7_200_000;
    c = await restart(adapter, t.opts);
    expect(
      (await c.call<Any>('sessions.summaries', { sessionIds: ['h1', 'h2', 'h3'] })).items,
    ).toMatchObject([
      { bucket: 'archived' },
      { bucket: 'active', backFromHold: true },
      { bucket: 'onHold', backFromHold: false },
    ]);
    expect(await c.call<Any>('places.counts', {})).toMatchObject({
      active: 1,
      all: 1,
      onHold: 1,
      archived: 1,
      needsYou: 1,
    });
  });
});

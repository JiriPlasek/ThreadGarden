import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  PowerConfigSchema,
  type ChatStatus,
  type EventMsg,
} from '@threadgarden/protocol';
import { IdleMonitor } from '../../src/power/idle.js';
import { PowerStore } from '../../src/power/store.js';
import { registerPowerMachineHandlers } from '../../src/server/handlers/power.js';
import { Router } from '../../src/server/router.js';
import { startService } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';

type S = { live: boolean; status: ChatStatus; runningAgents?: number; lastActivity?: number };
type E = { status?: string; state?: string };

const MIN = 60_000;

const rig = (o: { minutes?: number | null } = {}) => {
  const s = {
    sessions: [] as S[],
    external: [] as E[],
    now: 1_000_000,
    minutes: o.minutes === undefined ? 60 : o.minutes,
  };
  const m = new IdleMonitor({
    sessions: () => s.sessions,
    external: () => s.external,
    minutes: () => s.minutes,
    now: () => s.now,
  });
  return { s, m };
};

describe('idle: what is busy', () => {
  it('needsYou without running tasks is idle; working is busy; an external busy session is busy', () => {
    const { s, m } = rig();
    s.sessions = [{ live: true, status: 'needsYou' }];
    m.tick();
    expect(m.busy).toBe(false);
    expect(m.idleSince).toBe(s.now);

    s.sessions = [{ live: true, status: 'needsYou', runningAgents: 1 }];
    m.tick();
    expect(m.busy).toBe(true);
    expect(m.idleSince).toBeNull();

    s.sessions = [{ live: true, status: 'working' }];
    m.tick();
    expect(m.busy).toBe(true);

    s.sessions = [{ live: false, status: 'working' }];
    m.tick();
    expect(m.busy).toBe(false);

    s.sessions = [{ live: false, status: 'working', runningAgents: 2 }];
    m.tick();
    expect(m.busy).toBe(true);

    s.sessions = [];
    s.external = [{ status: 'waiting' }, { status: 'idle' }, {}];
    m.tick();
    expect(m.busy).toBe(false);
    s.external = [{ status: 'busy' }];
    m.tick();
    expect(m.busy).toBe(true);
  });

  it('keeps idleSince while idle and restarts it after a busy spell', () => {
    const { s, m } = rig();
    m.tick();
    const first = m.idleSince;
    s.now += 5 * MIN;
    m.tick();
    expect(m.idleSince).toBe(first);
    s.external = [{ status: 'busy' }];
    m.tick();
    s.external = [];
    s.now += MIN;
    m.tick();
    expect(m.idleSince).toBe(s.now);
  });
});

describe('idle: when it is due', () => {
  it('due after 60 idle minutes, not before', () => {
    const { s, m } = rig();
    m.tick();
    expect(m.due()).toBe(false);
    s.now += 59 * MIN;
    m.tick();
    expect(m.due()).toBe(false);
    expect(m.shutsDownAt()).toBe(m.idleSince! + 60 * MIN);
    s.now += MIN;
    m.tick();
    expect(m.due()).toBe(true);
  });

  it('is never due when the setting is never, or while busy', () => {
    const { s, m } = rig({ minutes: null });
    m.tick();
    s.now += 1000 * MIN;
    m.tick();
    expect(m.due()).toBe(false);
    expect(m.shutsDownAt()).toBeNull();
    s.minutes = 60;
    s.external = [{ status: 'busy' }];
    m.tick();
    expect(m.due()).toBe(false);
    expect(m.shutsDownAt()).toBeNull();
  });

  it("keepAwake 'always' blocks; 'until' expires on its own; a past 'until' is off", () => {
    const { s, m } = rig();
    m.tick();
    s.now += 120 * MIN;
    m.tick();
    expect(m.due()).toBe(true);

    m.setKeepAwake({ mode: 'always', until: null });
    expect(m.due()).toBe(false);
    expect(m.shutsDownAt()).toBeNull();

    m.setKeepAwake({ mode: 'until', until: s.now + 10 * MIN });
    expect(m.due()).toBe(false);
    expect(m.keepAwake).toEqual({ mode: 'until', until: s.now + 10 * MIN });
    s.now += 10 * MIN;
    expect(m.keepAwake).toEqual({ mode: 'off', until: null });
    expect(m.due()).toBe(false); // idle starts fresh when keep awake ends
    s.now += 60 * MIN;
    expect(m.due()).toBe(true);

    m.setKeepAwake({ mode: 'until', until: s.now - 1 });
    expect(m.keepAwake).toEqual({ mode: 'off', until: null });
    m.setKeepAwake({ mode: 'until', until: null });
    expect(m.keepAwake).toEqual({ mode: 'off', until: null });
  });
});

describe('idle: fix round 1', () => {
  it('a turn between ticks pushes the shutdown out (lastActivity)', () => {
    const { s, m } = rig();
    m.tick();
    const since = m.idleSince!;
    s.now += 30 * MIN;
    s.sessions = [{ live: true, status: 'idle', lastActivity: s.now - 5_000 }];
    m.tick();
    expect(m.busy).toBe(false);
    expect(m.idleSince).toBe(s.now - 5_000);
    expect(m.shutsDownAt()).toBe(s.now - 5_000 + 60 * MIN);
    expect(m.idleSince!).toBeGreaterThan(since);
    // an old activity changes nothing
    s.sessions = [{ live: true, status: 'idle', lastActivity: since - 1 }];
    m.tick();
    expect(m.idleSince).toBe(s.now - 5_000);
  });

  it("an external session in state 'working' is busy", () => {
    const { s, m } = rig();
    s.external = [{ state: 'working' }];
    m.tick();
    expect(m.busy).toBe(true);
    s.external = [{ state: 'done' }];
    m.tick();
    expect(m.busy).toBe(false);
  });

  it('only running agents keep it busy, not shells', () => {
    const { s, m } = rig();
    // the host reports no runningAgents for a chat that has only a shell task
    s.sessions = [{ live: true, status: 'needsYou' }];
    m.tick();
    expect(m.busy).toBe(false);
    s.sessions = [{ live: true, status: 'needsYou', runningAgents: 1 }];
    m.tick();
    expect(m.busy).toBe(true);
  });

  it('keep awake survives a restart; an expired until restores as off', () => {
    const { s, m } = rig();
    m.restoreKeepAwake({ mode: 'always', until: null });
    expect(m.keepAwake).toEqual({ mode: 'always', until: null });
    m.restoreKeepAwake({ mode: 'until', until: s.now + MIN });
    expect(m.keepAwake.mode).toBe('until');
    m.restoreKeepAwake({ mode: 'until', until: s.now - 1 });
    expect(m.keepAwake.mode).toBe('off');
    m.restoreKeepAwake('junk');
    expect(m.keepAwake.mode).toBe('off');
  });

  it('when keep awake ends, idle starts fresh', () => {
    const { s, m } = rig();
    m.tick();
    m.setKeepAwake({ mode: 'always', until: null });
    s.now += 120 * MIN;
    m.tick();
    m.setKeepAwake({ mode: 'off', until: null });
    expect(m.due()).toBe(false);
    expect(m.shutsDownAt()).toBe(s.now + 60 * MIN);
    s.now += 59 * MIN;
    expect(m.due()).toBe(false);
    s.now += MIN;
    expect(m.due()).toBe(true);
  });

  it('when keep awake runs out, idle starts at that moment', () => {
    const { s, m } = rig();
    m.tick();
    const until = s.now + 90 * MIN;
    m.setKeepAwake({ mode: 'until', until });
    s.now += 100 * MIN;
    m.tick();
    expect(m.shutsDownAt()).toBe(until + 60 * MIN);
    expect(m.due()).toBe(false);
    s.now = until + 60 * MIN;
    expect(m.due()).toBe(true);
  });
});

describe('machine power handlers', () => {
  it('power.status announces a change that notify would otherwise miss, once', async () => {
    const { m } = rig();
    const events: EventMsg[] = [];
    const router = new Router({ debug() {}, info() {}, warn() {}, error() {} } as never);
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-power-notify-'));
    try {
      const handlers = registerPowerMachineHandlers(router, {
        store: new PowerStore(dir),
        idle: m,
        emit: (e) => events.push(e),
      });
      m.setKeepAwake({ mode: 'always', until: null });
      const res = (await router.dispatch(
        { id: 1, method: 'power.status', params: {} } as never,
        { clientId: 'p', origin: 'remote', deviceId: 'd' } as never,
      )) as { result: unknown };
      expect(events).toEqual([{ event: 'power.changed', data: res.result }]);
      handlers.notify();
      expect(events.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('machine power handlers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-power-handlers-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const config = PowerConfigSchema.parse({
    kind: 'tasmota-plug',
    address: '192.168.1.9',
    device: null,
  });

  it('adopts, reports status without the password, and emits power.changed on every change', async () => {
    const { m } = rig();
    const events: EventMsg[] = [];
    const router = new Router({ debug() {}, info() {}, warn() {}, error() {} } as never);
    const handlers = registerPowerMachineHandlers(router, {
      store: new PowerStore(dir),
      idle: m,
      emit: (e) => events.push(e),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed results in tests
    const call = async (method: string, params: unknown): Promise<any> =>
      router.dispatch(
        { id: 1, method, params } as never,
        { clientId: 'p', origin: 'remote', deviceId: 'd' } as never,
      );

    expect((await call('power.status', {})).result).toMatchObject({
      configured: false,
      busy: false,
      phase: 'running',
    });
    // No password given and none stored.
    expect((await call('power.adopt', { config })).error?.code).toBe('POWER_NOT_CONFIGURED');
    expect(events).toEqual([]);

    expect((await call('power.adopt', { config, password: 'hunter2' })).result).toEqual({});
    expect((await call('power.status', {})).result.configured).toBe(true);
    expect(events.map((e) => e.event)).toEqual(['power.changed']);
    const status = await call('power.status', {});
    expect(JSON.stringify(status)).not.toMatch(/hunter2|password/i);

    // Re-adopting without a password keeps the stored one.
    expect((await call('power.adopt', { config: { ...config, offWatts: 9 } })).result).toEqual({});
    expect((await call('power.status', {})).result.configured).toBe(true);

    const kept = await call('power.keepAwake', { mode: 'always', until: null });
    expect(kept.result.keepAwake).toEqual({ mode: 'always', until: null });
    expect(kept.result.shutsDownAt).toBeNull();
    expect(events.at(-1)).toEqual({ event: 'power.changed', data: kept.result });

    expect((await call('power.adopt', { config: null })).result).toEqual({});
    expect((await call('power.status', {})).result.configured).toBe(false);

    // `notify` only speaks when something changed (the minute tick uses it).
    const before = events.length;
    handlers.notify();
    expect(events.length).toBe(before);
    m.setKeepAwake({ mode: 'off', until: null });
    handlers.notify();
    expect(events.length).toBe(before + 1);
  });
});

describe('power on a service', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-power-svc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const start = (headless: boolean) =>
    startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      headless,
      ...(headless ? { remote: { addresses: ['127.0.0.1'], port: 0 } } : {}),
      logger: { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} },
    });

  it('keep awake survives a service restart', async () => {
    const status = async (
      svc: Awaited<ReturnType<typeof start>>,
      method: string,
      params: unknown,
    ) =>
      (await svc.router.dispatch({ id: 1, method, params } as never, {
        clientId: 't',
        origin: 'local',
      })) as {
        result: { keepAwake: unknown };
      };
    const a = await start(true);
    await status(a, 'power.keepAwake', { mode: 'always', until: null });
    await a.close();
    const b = await start(true);
    expect((await status(b, 'power.status', {})).result.keepAwake).toEqual({
      mode: 'always',
      until: null,
    });
    await b.close();
  });

  it('capabilities include power only when headless', async () => {
    const hello = async (svc: Awaited<ReturnType<typeof start>>) =>
      (await svc.router.dispatch(
        { id: 1, method: 'hello', params: { protocolVersion: PROTOCOL_VERSION, client: 't' } },
        { clientId: 't', origin: 'local' },
      )) as {
        result: { machine: { capabilities: string[] } };
      };
    const h = await start(true);
    expect((await hello(h)).result.machine.capabilities).toEqual(['remote', 'power']);
    await h.close();
    await rm(join(dir, 'data'), { recursive: true, force: true });
    const d = await start(false);
    expect((await hello(d)).result.machine.capabilities).toEqual(['remote']);
    await d.close();
  });
});

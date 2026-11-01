import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatStatus,
  EventMsg,
  MachinePowerStatus,
  PowerConfig,
  Unpushed,
} from '@threadgarden/protocol';
import { IdleMonitor } from '../../src/power/idle.js';
import { ruleText } from '../../src/power/rules.js';
import { ShutdownSequence } from '../../src/power/shutdown.js';
import { PowerStore } from '../../src/power/store.js';
import { createSwitch } from '../../src/power/switch.js';
import { registerPowerMachineHandlers } from '../../src/server/handlers/power.js';
import { Router } from '../../src/server/router.js';
import { startService } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { startFakeTasmota, type FakeTasmota } from '../../src/testing/fake-tasmota.js';

const MIN = 60_000;

const cfg: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '',
  device: 'UbuntuPlug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const unpushed: Unpushed = {
  repo: '/w/app',
  branch: 'main',
  kind: 'unpushed',
  count: 2,
  sessionId: 's1',
  reason: null,
};

const fakes: FakeTasmota[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type RigOptions = {
  /** The password the machine stores (the switch's is `pw`); null: no switch configured. */
  password?: string | null;
  address?: string;
  found?: Unpushed[];
  sends?: { sendAt: number; state: string }[];
  poweroff?: () => Promise<void>;
  check?: (d: { cwd: string; sessionId: string | null }[]) => Promise<Unpushed[]>;
  /** The idle monitor's sessions, given what has happened so far. */
  sessions?: (order: string[]) => { live: boolean; status: ChatStatus; lastActivity?: number }[];
  /** Every command of the first switch made (onStart's) waits this long before it is sent. */
  slowFirstSwitchMs?: number;
  /** While this says true, the switch cannot be reached (no network yet). */
  offline?: () => boolean;
};

/** Timers that fire only when told to (the start disarm's retries). */
function manualTimers() {
  const scheduled: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const t = { fn, ms, live: true };
        scheduled.push(t);
        return t;
      },
      clear: (h: unknown) => {
        (h as { live: boolean }).live = false;
      },
    },
    /** The delays of the timers still waiting. */
    live: () => scheduled.filter((t) => t.live).map((t) => t.ms),
    fire: () => {
      for (const t of scheduled.splice(0)) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
  };
}

async function rig(o: RigOptions = {}) {
  const f = await startFakeTasmota({ password: 'pw' });
  fakes.push(f);
  const dataDir = await mkdtemp(join(tmpdir(), 'threadgarden-shutdown-'));
  dirs.push(dataDir);
  const config: PowerConfig = { ...cfg, address: o.address ?? f.address };
  const store = new PowerStore(dataDir);
  if (o.password !== null) store.save(config, o.password ?? 'pw');

  const clock = { now: 10_000_000 };
  /** Event tga, Timer16 writes, stopAll and poweroff, in the order they happened. */
  const order: string[] = [];
  const idle = new IdleMonitor({
    sessions: () => o.sessions?.(order) ?? [],
    external: () => [],
    minutes: () => 60,
    now: () => clock.now,
  });
  let switches = 0;
  const retries = manualTimers();
  const emitted: MachinePowerStatus[] = [];
  const checked: { cwd: string; sessionId: string | null }[][] = [];
  const seq = new ShutdownSequence({
    store,
    idle,
    dirs: () => [{ cwd: '/w/app', sessionId: 's1' }],
    scheduled: () => o.sends ?? [],
    stopAll: async () => {
      order.push('stopAll');
    },
    poweroff:
      o.poweroff ??
      (async () => {
        order.push('poweroff');
      }),
    check:
      o.check ??
      (async (d) => {
        checked.push(d);
        return o.found ?? [];
      }),
    makeSwitch: (c, p) => {
      const delay = switches++ === 0 ? (o.slowFirstSwitchMs ?? 0) : 0;
      return createSwitch(c, p, {
        readWaitMs: 0,
        fetch: async (input, init) => {
          if (delay > 0) await new Promise((res) => setTimeout(res, delay));
          if (o.offline?.()) {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
          }
          const cmnd = new URL(String(input)).searchParams.get('cmnd') ?? '';
          if (cmnd === 'Event tga' || cmnd.startsWith('Timer16 ')) order.push(cmnd);
          return fetch(input, init);
        },
      });
    },
    emit: (s) => emitted.push(s),
    timers: retries.timers,
  });
  return { f, config, store, idle, clock, seq, order, emitted, checked, retries };
}

/** A clean shutdown without a send waiting: the cut, no wake, then sessions and poweroff. */
const CLEAN = ['Event tga', 'Timer16 {"Enable":0}', 'stopAll', 'poweroff'];

/** A clean shutdown that wakes for a send at `at` (the fake switch is at UTC+1 by default). */
const withWake = (at: number, offsetMinutes = 60) => [
  'Event tga',
  `Timer16 ${JSON.stringify({ Enable: 1, Mode: 0, Time: wakeTime(at, offsetMinutes), Window: 0, Days: wakeDays(at, offsetMinutes), Repeat: 0, Action: 3 })}`,
  'stopAll',
  'poweroff',
];

const installRule = (f: FakeTasmota, config: PowerConfig) => {
  f.rules[1] = { text: ruleText(config), on: true };
};

describe('ShutdownSequence.run', () => {
  it('clean machine: arms the cut, then stops sessions, then powers off', async () => {
    const r = await rig();
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(r.order).toEqual(CLEAN);
    expect(r.checked).toEqual([[{ cwd: '/w/app', sessionId: 's1' }]]);
    expect(s.phase).toBe('shuttingDown');
    expect(s.problem).toBeNull();
    expect(r.emitted.map((e) => e.phase)).toEqual(['checking', 'shuttingDown']);
    // No send waiting: no wake either.
    expect(r.f.timers[16]).toMatchObject({ Enable: 0 });
  });

  it('unpushed work blocks: no arm, no poweroff, phase blocked', async () => {
    const r = await rig({ found: [unpushed] });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'blocked', unpushed: [unpushed], problem: null });
    expect(r.order).toEqual([]);
    expect(r.f.commands).toEqual([]);
    expect(r.emitted.at(-1)).toEqual(s);
    expect(r.seq.status()).toMatchObject({ phase: 'blocked', unpushed: [unpushed] });
  });

  it('a repository that could not be checked blocks like unpushed work', async () => {
    const unchecked: Unpushed = {
      ...unpushed,
      kind: 'unchecked',
      branch: null,
      count: 0,
      reason: 'git timed out',
    };
    const r = await rig({ found: [unchecked] });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'blocked', unpushed: [unchecked] });
    expect(r.order).toEqual([]);
  });

  it('force skips the push check', async () => {
    const r = await rig({ found: [unpushed] });
    const s = await r.seq.run({ force: true, reason: 'manual' });
    expect(r.checked).toEqual([]);
    expect(r.order).toEqual(CLEAN);
    expect(s).toMatchObject({ phase: 'shuttingDown', unpushed: [] });
  });

  it('switch refuses the password: no poweroff, problem set, phase running', async () => {
    const r = await rig({ password: 'wrong' });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(r.order).toEqual([]);
    expect(s).toMatchObject({ phase: 'running', problem: 'The switch refused the password.' });
    expect(JSON.stringify(r.emitted)).not.toMatch(/wrong/);
    expect(r.emitted.at(-1)).toEqual(s);
  });

  it('an unreachable switch: no poweroff, the problem says so', async () => {
    const r = await rig({ address: '127.0.0.1:1' });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(r.order).toEqual([]);
    expect(s.phase).toBe('running');
    expect(s.problem).toMatch(/127\.0\.0\.1:1/);
  });

  it('no switch configured: never powers off', async () => {
    const r = await rig({ password: null });
    const s = await r.seq.run({ force: true, reason: 'manual' });
    expect(r.order).toEqual([]);
    expect(s).toMatchObject({ phase: 'running', configured: false });
    expect(s.problem).toMatch(/power switch/i);
  });

  it('a send due in 10 min: no shutdown', async () => {
    const r = await rig({ sends: [{ sendAt: Date.now() + 10 * MIN, state: 'pending' }] });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'running', problem: 'A scheduled message is due soon' });
    expect(r.order).toEqual([]);
    expect(r.f.commands).toEqual([]);
  });

  it('an overdue send held back does not postpone the shutdown: it goes out at the next start', async () => {
    const r = await rig({ sends: [{ sendAt: Date.now() - 5 * MIN, state: 'pending' }] });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'shuttingDown', problem: null });
    expect(r.order).toEqual(CLEAN);
  });

  it('a failed or sending send does not count; the earliest pending one does', async () => {
    const at = Date.now() + 3 * 60 * MIN;
    const r = await rig({
      sends: [
        { sendAt: Date.now() + 2 * MIN, state: 'failed' },
        { sendAt: Date.now() + 3 * MIN, state: 'sending' },
        { sendAt: at + 60 * MIN, state: 'pending' },
        { sendAt: at, state: 'pending' },
      ],
    });
    await r.seq.run({ force: false, reason: 'idle' });
    expect(r.order).toEqual(withWake(at));
    expect(r.f.timers[16]).toMatchObject({ Enable: 1, Time: wakeTime(at, r.f.utcOffsetMinutes) });
  });

  it('a send due in 3 h: Timer16 armed for 5 min before, then poweroff', async () => {
    const at = Date.now() + 3 * 60 * MIN;
    const r = await rig({ sends: [{ sendAt: at, state: 'pending' }] });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    const local = new Date(at - 5 * MIN + r.f.utcOffsetMinutes * MIN);
    expect(r.f.timers[16]).toMatchObject({
      Enable: 1,
      Time: wakeTime(at, r.f.utcOffsetMinutes),
      Days: Array.from({ length: 7 }, (_, i) => (i === local.getUTCDay() ? '1' : '0')).join(''),
      Repeat: 0,
      Action: 3,
    });
    const tga = r.f.commands.indexOf('Event tga');
    const timer = r.f.commands.findIndex((c) => c.startsWith('Timer16 {"Enable":1'));
    expect(tga).toBeGreaterThanOrEqual(0);
    expect(timer).toBeGreaterThan(tga);
    expect(r.order).toEqual(withWake(at, r.f.utcOffsetMinutes));
    expect(s.phase).toBe('shuttingDown');
  });

  it('a send more than 7 days out: no wake, and it still shuts down', async () => {
    const r = await rig({ sends: [{ sendAt: Date.now() + 8 * 24 * 60 * MIN, state: 'pending' }] });
    // An earlier wake of ours is still set.
    installRule(r.f, r.config);
    r.f.timers[16] = {
      Enable: 1,
      Mode: 0,
      Time: '01:00',
      Window: 0,
      Days: '1000000',
      Repeat: 0,
      Action: 3,
    };
    await r.seq.run({ force: false, reason: 'idle' });
    expect(r.f.timers[16]).toMatchObject({ Enable: 0 });
    expect(r.order).toEqual(CLEAN);
  });

  it('timers switched off on the switch: no poweroff, the cut is disarmed again', async () => {
    const r = await rig({ sends: [{ sendAt: Date.now() + 3 * 60 * MIN, state: 'pending' }] });
    r.f.timersOn = false;
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(r.order).toEqual(['Event tga', 'Timer16 {"Enable":0}']);
    expect(s.phase).toBe('running');
    expect(s.problem).toMatch(/Timers are switched off/);
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('poweroff fails: disarms, stays running and says why', async () => {
    const r = await rig({
      poweroff: async () => {
        throw new Error('Access denied');
      },
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({
      phase: 'running',
      problem: 'The machine refused to power off (Access denied)',
    });
    const tga = r.f.commands.indexOf('Event tga');
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(tga);
    expect(r.f.commands.lastIndexOf('Timer16 {"Enable":0}')).toBeGreaterThan(tga);
    expect(r.emitted.at(-1)).toEqual(s);
  });

  it('systemctl exiting non-zero is a refusal: disarmed, and stderr says why', async () => {
    const r = await rig({
      poweroff: async () => {
        throw Object.assign(new Error('Command failed: systemctl poweroff'), {
          code: 1,
          signal: null,
          killed: false,
          stderr: 'Failed to power off system via logind: Access denied\n',
        });
      },
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({
      phase: 'running',
      problem:
        'The machine refused to power off (Failed to power off system via logind: Access denied)',
    });
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('systemctl ended by a signal (the shutdown itself stops it): the cut stays armed', async () => {
    const r = await rig({
      poweroff: async () => {
        throw Object.assign(new Error('Command failed: systemctl poweroff'), {
          code: null,
          signal: 'SIGTERM',
          killed: false,
        });
      },
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({ phase: 'shuttingDown', problem: null });
    expect(r.f.commands).toContain('Event tga');
    expect(r.f.commands).not.toContain('Event tgo');
    expect(r.f.commands.filter((c) => c.startsWith('Timer16 '))).toEqual(['Timer16 {"Enable":0}']);
  });

  it('systemctl killed by our own timeout is a refusal: disarmed, running, and says so', async () => {
    const r = await rig({
      poweroff: async () => {
        throw Object.assign(new Error('Command failed: systemctl poweroff'), {
          code: null,
          signal: 'SIGTERM',
          killed: true,
        });
      },
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({
      phase: 'running',
      problem: 'The machine refused to power off (systemctl timed out)',
    });
    const tga = r.f.commands.indexOf('Event tga');
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(tga);
    expect(r.f.commands.lastIndexOf('Timer16 {"Enable":0}')).toBeGreaterThan(tga);
  });

  it('systemctl that cannot be started (ENOENT) is a refusal', async () => {
    const r = await rig({
      poweroff: async () => {
        throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
      },
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({
      phase: 'running',
      problem: 'The machine refused to power off (spawn systemctl ENOENT)',
    });
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('something unexpected after arming disarms again and never powers off', async () => {
    let thrown = false;
    const r = await rig({
      // The first status read after the cut is armed fails.
      sessions: (order) => {
        if (order.includes('Event tga') && !thrown) {
          thrown = true;
          throw new Error('the session list is gone');
        }
        return [];
      },
    });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(thrown).toBe(true);
    expect(s).toMatchObject({ phase: 'running', problem: 'The shutdown stopped unexpectedly.' });
    expect(r.order).not.toContain('stopAll');
    expect(r.order).not.toContain('poweroff');
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('a turn that starts while the cut is armed: disarmed again, no poweroff', async () => {
    const r = await rig({
      sessions: (order) => (order.includes('Event tga') ? [{ live: true, status: 'working' }] : []),
    });
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'running', problem: null });
    expect(r.order).not.toContain('stopAll');
    expect(r.order).not.toContain('poweroff');
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('a turn that began and ended during the sequence stops it too, and idle starts afresh', async () => {
    const r = await rig({
      sessions: (order) =>
        order.includes('Event tga')
          ? [{ live: true, status: 'idle', lastActivity: Date.now() + 1 }]
          : [],
    });
    r.idle.tick();
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s).toMatchObject({ phase: 'running', problem: null });
    // Idle counts from the chat's activity: a whole idle period before the next try.
    expect(s.idleSince).toBeGreaterThanOrEqual(r.clock.now);
    expect(r.idle.due()).toBe(false);
    expect(r.order).not.toContain('poweroff');
    expect(r.f.commands.lastIndexOf('Event tgo')).toBeGreaterThan(
      r.f.commands.indexOf('Event tga'),
    );
  });

  it('a manual shutdown of a machine already at work goes ahead (the owner was asked)', async () => {
    const r = await rig({
      sessions: () => [{ live: true, status: 'working', lastActivity: Date.now() + 60_000 }],
    });
    const s = await r.seq.run({ force: false, reason: 'manual' });
    expect(s.phase).toBe('shuttingDown');
    expect(r.order).toEqual(CLEAN);
  });

  it('a run waits for the disarm at start: it never interleaves with a slow switch', async () => {
    const at = Date.now() + 3 * 60 * MIN;
    const r = await rig({ sends: [{ sendAt: at, state: 'pending' }], slowFirstSwitchMs: 60 });
    installRule(r.f, r.config);
    const starting = r.seq.onStart();
    const s = await r.seq.run({ force: true, reason: 'manual' });
    await starting;
    expect(s.phase).toBe('shuttingDown');
    const c = r.f.commands;
    expect(c.indexOf('Event tgo')).toBeGreaterThanOrEqual(0);
    expect(c.indexOf('Event tgo')).toBeLessThan(c.indexOf('Event tga'));
    expect(c.indexOf('Timer16 {"Enable":0}')).toBeLessThan(
      c.findIndex((x) => x.startsWith('Timer16 {"Enable":1')),
    );
    // The wake survives: onStart's clearing came first.
    expect(r.f.timers[16]).toMatchObject({ Enable: 1 });
  });

  it('runs one sequence at a time: a second call returns the current status', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let checks = 0;
    const r = await rig({
      check: async () => {
        checks++;
        await gate;
        return [];
      },
    });
    const first = r.seq.run({ force: false, reason: 'idle' });
    await new Promise((res) => setImmediate(res));
    const second = await r.seq.run({ force: false, reason: 'manual' });
    expect(second.phase).toBe('checking');
    release();
    expect((await first).phase).toBe('shuttingDown');
    expect(checks).toBe(1);
    expect(r.order).toEqual(CLEAN);
  });

  it('a blocked machine is running again once a chat turn starts or ends', async () => {
    const r = await rig({ found: [unpushed] });
    expect((await r.seq.run({ force: false, reason: 'idle' })).phase).toBe('blocked');
    const before = r.emitted.length;
    r.seq.activity();
    expect(r.seq.status()).toMatchObject({ phase: 'running', unpushed: [], problem: null });
    expect(r.emitted.length).toBe(before + 1);
    expect(r.emitted.at(-1)).toMatchObject({ phase: 'running', unpushed: [] });
    // Nothing to clear: nothing announced.
    r.seq.activity();
    expect(r.emitted.length).toBe(before + 1);
  });

  it('a new run clears an earlier problem and block', async () => {
    let found: Unpushed[] = [unpushed];
    const r = await rig({ check: async () => found });
    expect((await r.seq.run({ force: false, reason: 'idle' })).phase).toBe('blocked');
    found = [];
    const s = await r.seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'shuttingDown', unpushed: [], problem: null });
  });

  it('once shutting down, another run starts nothing', async () => {
    const r = await rig();
    await r.seq.run({ force: false, reason: 'idle' });
    const again = await r.seq.run({ force: true, reason: 'manual' });
    expect(again.phase).toBe('shuttingDown');
    expect(r.order).toEqual(CLEAN);
  });

  it('something unexpected never leaves it checking, and never powers off', async () => {
    const r = await rig();
    const seq = new ShutdownSequence({
      store: r.store,
      idle: r.idle,
      dirs: () => [],
      scheduled: () => {
        throw new Error('database is closed');
      },
      stopAll: async () => {},
      poweroff: async () => {
        r.order.push('poweroff');
      },
      check: async () => [],
      emit: () => {
        throw new Error('no clients');
      },
    });
    const s = await seq.run({ force: false, reason: 'idle' });
    expect(s).toMatchObject({ phase: 'running', problem: 'The shutdown stopped unexpectedly.' });
    expect(r.order).toEqual([]);
    expect(r.f.commands).toEqual([]);
  });
});

describe('ShutdownSequence.onStart', () => {
  it('onStart disarms', async () => {
    const r = await rig();
    installRule(r.f, r.config);
    await r.seq.onStart();
    expect(r.f.commands).toContain('Event tgo');
    expect(r.f.commands).toContain('Timer16 {"Enable":0}');
  });

  it('ignores a switch without our rule, an unreachable switch, and no switch at all', async () => {
    const plain = await rig();
    await expect(plain.seq.onStart()).resolves.toBeUndefined();
    expect(plain.f.commands).toContain('Event tgo');

    const away = await rig({ address: '127.0.0.1:1' });
    await expect(away.seq.onStart()).resolves.toBeUndefined();

    const none = await rig({ password: null });
    await expect(none.seq.onStart()).resolves.toBeUndefined();
    expect(none.f.commands).toEqual([]);
    expect(none.retries.live()).toEqual([]);
  });

  /** A wake of ours, still set from before the machine went down. */
  const staleWake = (r: Awaited<ReturnType<typeof rig>>) => {
    installRule(r.f, r.config);
    r.f.timers[16] = {
      Enable: 1,
      Mode: 0,
      Time: '01:00',
      Window: 0,
      Days: '1000000',
      Repeat: 0,
      Action: 3,
    };
  };

  it('no network yet at start: retries every 10 s until the wake is cleared', async () => {
    let offline = true;
    const r = await rig({ offline: () => offline });
    staleWake(r);
    await r.seq.onStart();
    expect(r.f.commands).toEqual([]);
    expect(r.retries.live()).toEqual([10_000]);
    r.retries.fire();
    await vi.waitFor(() => expect(r.retries.live()).toEqual([10_000]));
    expect(r.f.timers[16]).toMatchObject({ Enable: 1 });
    offline = false;
    r.retries.fire();
    await vi.waitFor(() => expect(r.f.timers[16]).toMatchObject({ Enable: 0 }));
    expect(r.f.commands).toContain('Event tgo');
    expect(r.retries.live()).toEqual([]);
  });

  it('after a few minutes of retries the minute tick keeps trying', async () => {
    let offline = true;
    const r = await rig({ offline: () => offline });
    staleWake(r);
    await r.seq.onStart();
    for (let i = 0; i < 30; i++) {
      expect(r.retries.live()).toEqual([10_000]);
      r.retries.fire();
      await new Promise((res) => setTimeout(res, 5));
    }
    await vi.waitFor(() => expect(r.retries.live()).toEqual([]));
    expect(r.f.timers[16]).toMatchObject({ Enable: 1 });
    // The minute tick, still offline: nothing yet, and no shutdown is attempted either.
    await r.seq.idleTick();
    expect(r.f.timers[16]).toMatchObject({ Enable: 1 });
    offline = false;
    await r.seq.idleTick();
    expect(r.f.commands).toContain('Event tgo');
    expect(r.f.timers[16]).toMatchObject({ Enable: 0 });
  });

  it('a run while the start disarm is pending disarms first, and never arms without it', async () => {
    let offline = true;
    const r = await rig({ offline: () => offline });
    staleWake(r);
    await r.seq.onStart();
    const failed = await r.seq.run({ force: true, reason: 'manual' });
    expect(failed.phase).toBe('running');
    expect(failed.problem).toMatch(/did not answer/);
    expect(r.order).toEqual([]);
    offline = false;
    const s = await r.seq.run({ force: true, reason: 'manual' });
    expect(s.phase).toBe('shuttingDown');
    const c = r.f.commands;
    expect(c.indexOf('Event tgo')).toBeGreaterThanOrEqual(0);
    expect(c.indexOf('Event tgo')).toBeLessThan(c.indexOf('Event tga'));
    // The start disarm's clearing of the wake, then a clean shutdown.
    expect(r.order).toEqual(['Timer16 {"Enable":0}', ...CLEAN]);
    // Done: no retry is left to disarm the cut just armed.
    r.retries.fire();
    await new Promise((res) => setTimeout(res, 20));
    expect(c.lastIndexOf('Event tgo')).toBeLessThan(c.indexOf('Event tga'));
  });
});

describe('ShutdownSequence.idleTick (the minute tick)', () => {
  it('runs only when configured and idle long enough', async () => {
    const none = await rig({ password: null });
    none.idle.tick();
    none.clock.now += 61 * MIN;
    await none.seq.idleTick();
    expect(none.checked).toEqual([]);

    const r = await rig();
    r.idle.tick();
    r.clock.now += 59 * MIN;
    await r.seq.idleTick();
    expect(r.checked).toEqual([]);
    r.clock.now += 2 * MIN;
    await r.seq.idleTick();
    expect(r.order).toEqual(CLEAN);
    // Shutting down: the tick never starts another sequence.
    await r.seq.idleTick();
    expect(r.checked.length).toBe(1);
  });

  it('a blocked machine starts a fresh idle period and checks again once it is over', async () => {
    let found: Unpushed[] = [unpushed];
    let checks = 0;
    const r = await rig({
      check: async () => {
        checks++;
        return found;
      },
    });
    r.idle.tick();
    r.clock.now += 61 * MIN;
    await r.seq.idleTick();
    expect(r.seq.status()).toMatchObject({ phase: 'blocked', idleSince: r.clock.now });
    expect(checks).toBe(1);
    r.clock.now += 30 * MIN;
    await r.seq.idleTick();
    expect(checks).toBe(1);
    found = [];
    r.clock.now += 31 * MIN;
    await r.seq.idleTick();
    expect(checks).toBe(2);
    expect(r.order).toEqual(CLEAN);
  });

  it('a problem waits a fresh idle period too, instead of retrying every minute', async () => {
    const r = await rig({ password: 'wrong' });
    r.idle.tick();
    r.clock.now += 61 * MIN;
    await r.seq.idleTick();
    expect(r.checked.length).toBe(1);
    expect(r.seq.status().problem).toBe('The switch refused the password.');
    r.clock.now += MIN;
    await r.seq.idleTick();
    expect(r.checked.length).toBe(1);
    r.clock.now += 60 * MIN;
    await r.seq.idleTick();
    expect(r.checked.length).toBe(2);
    expect(r.order).toEqual([]);
  });
});

describe('power.shutdown and power.status', () => {
  it('power.shutdown runs the sequence for a paired device; power.status shows its phase', async () => {
    const r = await rig({ found: [unpushed] });
    const events: EventMsg[] = [];
    const router = new Router({ debug() {}, info() {}, warn() {}, error() {} } as never);
    registerPowerMachineHandlers(router, {
      store: r.store,
      idle: r.idle,
      shutdown: r.seq,
      emit: (e) => events.push(e),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed results in tests
    const call = async (method: string, params: unknown): Promise<any> =>
      router.dispatch(
        { id: 1, method, params } as never,
        { clientId: 'p', origin: 'remote', deviceId: 'd' } as never,
      );

    const blocked = await call('power.shutdown', { force: false });
    expect(blocked.result).toMatchObject({ phase: 'blocked', unpushed: [unpushed] });
    expect((await call('power.status', {})).result).toMatchObject({
      phase: 'blocked',
      unpushed: [unpushed],
    });

    const forced = await call('power.shutdown', { force: true });
    expect(forced.result).toMatchObject({ phase: 'shuttingDown', unpushed: [] });
    expect(r.order).toEqual(CLEAN);
    expect(JSON.stringify(events)).not.toMatch(/"pw"|password/i);
  });
});

describe('the headless service', () => {
  const start = (dir: string, o: { headless: boolean; poweroff: () => Promise<void> }) =>
    startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      headless: o.headless,
      poweroff: o.poweroff,
      ...(o.headless ? { remote: { addresses: ['127.0.0.1'], port: 0 } } : {}),
      logger: { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} },
    });

  it('disarms at start and powers off on power.shutdown once the switch is armed', async () => {
    const f = await startFakeTasmota({ password: 'pw' });
    fakes.push(f);
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-shutdown-svc-'));
    dirs.push(dir);
    const config: PowerConfig = { ...cfg, address: f.address };
    installRule(f, config);
    await mkdir(join(dir, 'data'), { recursive: true });
    new PowerStore(join(dir, 'data')).save(config, 'pw');
    let powered = 0;
    const svc = await start(dir, { headless: true, poweroff: async () => void powered++ });
    try {
      await expect.poll(() => f.commands.includes('Timer16 {"Enable":0}')).toBe(true);
      expect(f.commands).toContain('Event tgo');
      const res = (await svc.router.dispatch(
        { id: 1, method: 'power.shutdown', params: { force: true } } as never,
        { clientId: 'p', origin: 'remote', deviceId: 'd' } as never,
      )) as { result: MachinePowerStatus };
      expect(res.result.phase).toBe('shuttingDown');
      expect(f.commands).toContain('Event tga');
      expect(powered).toBe(1);
    } finally {
      await svc.close();
    }
  });

  it('has no power.shutdown on a desktop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-shutdown-desk-'));
    dirs.push(dir);
    let powered = 0;
    const svc = await start(dir, { headless: false, poweroff: async () => void powered++ });
    try {
      const res = (await svc.router.dispatch(
        { id: 1, method: 'power.shutdown', params: { force: true } } as never,
        { clientId: 'l', origin: 'local' } as never,
      )) as { error?: { code: string } };
      expect(res.error).toBeDefined();
      expect(powered).toBe(0);
    } finally {
      await svc.close();
    }
  });
});

/** The device's weekday mask for a wake 5 min before `at`. */
function wakeDays(at: number, offsetMinutes: number): string {
  const local = new Date(at - 5 * MIN + offsetMinutes * MIN);
  return Array.from({ length: 7 }, (_, i) => (i === local.getUTCDay() ? '1' : '0')).join('');
}

/** HH:MM on the device for a wake 5 min before `at`. */
function wakeTime(at: number, offsetMinutes: number): string {
  const local = new Date(at - 5 * MIN + offsetMinutes * MIN);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

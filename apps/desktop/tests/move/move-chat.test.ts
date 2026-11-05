import {
  MOVE_CAPABILITY,
  MOVE_ERRORS,
  POWER_CAPABILITY,
  type GitState,
  type MachinePowerStatus,
  type PowerConfig,
  type ScheduledSend,
} from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markOldCopy,
  MoveChat,
  RECONNECT_WAIT_MS,
  START_WAIT_MS,
} from '../../src/lib/move/move-chat.svelte';
import { moveNote } from '../../src/lib/move/note';
import type { AppState } from '../../src/lib/state/context';
import { LOCAL, M1, machineInfo, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const REF = { machineId: LOCAL, sessionId: 's1' };
const ORIGIN = 'https://github.com/jiri/tg-cli.git';
const CLEAN: GitState = { kind: 'clean', branch: 'main', origin: ORIGIN };
const TARGET_FOLDER = '/home/u/tg-cli';

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const powerStatus = (): MachinePowerStatus => ({
  configured: true,
  busy: false,
  idleSince: null,
  shutsDownAt: null,
  keepAwake: { mode: 'off', until: null },
  phase: 'running',
  unpushed: [],
  problem: null,
});

const pending = (over: Partial<ScheduledSend>): ScheduledSend => ({
  id: 'q',
  sessionId: 's1',
  text: 'go on',
  imageCount: 0,
  sendAt: Date.now() + 3_600_000,
  createdAt: Date.now(),
  state: 'pending',
  afterLimitReset: false,
  rescheduled: false,
  ...over,
});

type Handler = (p: unknown) => unknown;
type P = Record<string, unknown>;

let apps: AppState[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const app of apps) app.power.stop();
  apps = [];
});

/**
 * This PC holds chat s1 (the source), Ubuntu PC is the target. Every move
 * call, scheduled send, draft and send of s1 lands in `log` as `side method`.
 */
const start = async (
  o: {
    git?: GitState;
    /** M1 is off (its relay refuses); `power`: it has power control. */
    off?: boolean;
    power?: boolean;
    /** Power comes back when turned on (default true). */
    comesUp?: boolean;
    /** This PC's service can move chats (default true). */
    localMove?: boolean;
    source?: Record<string, Handler>;
    target?: Record<string, Handler>;
  } = {},
) => {
  const log: string[] = [];
  const record = (side: string, s: FakeServer, handlers: Record<string, Handler>): void => {
    for (const [method, h] of Object.entries(handlers)) {
      s.handlers[method] = (p) => {
        log.push(`${side} ${method}`);
        return h(p);
      };
    }
  };
  let remote!: FakeServer;
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', MOVE_CAPABILITY, ...(o.power ? [POWER_CAPABILITY] : [])],
    powerPasswords: { [M1]: 'pw' },
    waitForOn: !o.off,
    configure: (s) => {
      const hello = s.handlers['hello']!;
      s.handlers['hello'] = (p) => ({
        ...(hello(p) as object),
        machine: machineInfo(LOCAL, 'my-host', [
          'remote',
          ...(o.localMove === false ? [] : [MOVE_CAPABILITY]),
        ]),
      });
      s.handlers['power.list'] = () => (o.power ? [{ machineId: M1, config: CONFIG }] : []);
      s.handlers['power.reading'] = () => ({
        on: !o.off,
        watts: o.off ? 0 : 60,
        at: Date.now(),
      });
      s.handlers['power.unlock'] = () => ({});
      s.handlers['power.noteMeasurement'] = () => ({});
      record('source', s, {
        'move.check': () => ({ cwd: 'C:\\work\\tg-cli', busy: null, git: o.git ?? CLEAN }),
        'move.exportBegin': (p) => ({ exportId: (p as P).exportId, parts: 2, bytes: 100 }),
        'move.exportPart': (p) => ({
          keys: [{ entries: [{ type: 'user', part: (p as P).index }] }],
        }),
        'move.abort': () => ({}),
        'move.markMoved': () => ({}),
        'scheduled.cancel': () => ({}),
        'drafts.get': () => ({ text: 'half a thought' }),
        'chat.send': () => ({ queued: false }),
        ...o.source,
      });
      // The scheduled store lists every chat's ({}); only the move lists s1's.
      s.handlers['scheduled.list'] = (p) => {
        if ((p as P).sessionId === undefined) return { items: [] };
        log.push('source scheduled.list');
        return (o.source?.['scheduled.list'] ?? (() => ({ items: [] })))(p);
      };
      record('power', s, {
        'power.turnOn': () => {
          if (o.comesUp !== false) remote.refuse = false;
          return { cycled: false, waitMs: 0 };
        },
      });
    },
    configureRemote: (s) => {
      remote = s;
      s.handlers['power.status'] = () => powerStatus();
      s.handlers['power.adopt'] = () => ({});
      record('target', s, {
        'move.target': () => ({ folder: TARGET_FOLDER, matched: true, inUse: null }),
        'move.importPart': () => ({}),
        'move.commit': (p) => ({ summary: summary('s1', { cwd: (p as P).cwd as string }) }),
        'scheduled.create': (p) => pending(p as Partial<ScheduledSend>),
        'drafts.set': () => ({}),
        'chat.send': () => ({ queued: false }),
        ...o.target,
      });
      if (o.off) s.refuse = true;
    },
  });
  apps.push(env.app);
  env.app.tabs.openTab(REF);
  const move = new MoveChat(env.app, { retryMs: 0 });
  return { ...env, log, move };
};

const paramsOf = (s: FakeServer, method: string): P[] => s.calls(method).map((c) => c.params as P);

const noteFor = (o: { leftBehind?: string | null } = {}) =>
  moveNote({
    from: 'This PC',
    to: 'Ubuntu PC',
    folder: TARGET_FOLDER,
    origin: ORIGIN,
    branch: 'main',
    leftBehind: o.leftBehind ?? null,
    inUse: false,
  });

/** The clock the Off tests fake (microtasks stay real: the fake sockets answer in them). */
const FAKE: ('setTimeout' | 'clearTimeout' | 'Date')[] = ['setTimeout', 'clearTimeout', 'Date'];

const shownOf = (app: AppState) => app.machines.shown(app.machines.get(M1)!);

describe('MoveChat', () => {
  it('clean chat moves: calls in order, tab re-keyed to the target, draft copied, note sent', async () => {
    const { move, log, server, remote, app } = await start();
    const before = Date.now();
    await move.prepare(REF, M1);
    expect(move.state).toBe('ready');
    expect(move.check?.source.git).toEqual(CLEAN);
    expect(move.check?.target?.folder).toBe(TARGET_FOLDER);

    await move.run({ moveAnyway: false });

    expect(move.state).toBe('done');
    expect(move.problem).toBeNull();
    expect(move.oldCopyShown).toBe(false);
    expect(log).toEqual([
      'source move.check',
      'target move.target',
      'source move.exportBegin',
      'source move.exportPart',
      'target move.importPart',
      'source move.exportPart',
      'target move.importPart',
      'target move.commit',
      'source move.markMoved',
      'source scheduled.list',
      'source drafts.get',
      'target drafts.set',
      'target chat.send',
    ]);
    const { exportId } = paramsOf(server, 'move.exportBegin')[0]!;
    expect(exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(paramsOf(server, 'move.exportBegin')[0]).toEqual({ sessionId: 's1', exportId });
    expect(paramsOf(server, 'move.exportPart')).toEqual([
      { exportId, index: 0 },
      { exportId, index: 1 },
    ]);
    const imports = paramsOf(remote, 'move.importPart');
    const { importId } = imports[0]!;
    expect(importId).toMatch(/^[0-9a-f-]{36}$/);
    expect(imports).toEqual([
      {
        importId,
        sessionId: 's1',
        index: 0,
        parts: 2,
        keys: [{ entries: [{ type: 'user', part: 0 }] }],
      },
      {
        importId,
        sessionId: 's1',
        index: 1,
        parts: 2,
        keys: [{ entries: [{ type: 'user', part: 1 }] }],
      },
    ]);
    expect(paramsOf(remote, 'move.commit')).toEqual([
      {
        importId,
        sessionId: 's1',
        cwd: TARGET_FOLDER,
        from: { machineId: LOCAL, name: 'This PC' },
      },
    ]);
    // Taken just before exportBegin: markMoved works without the source's memory of it.
    expect(paramsOf(server, 'move.markMoved')).toEqual([
      {
        exportId,
        sessionId: 's1',
        begunAt: expect.any(Number),
        to: { machineId: M1, name: 'Ubuntu PC' },
      },
    ]);
    expect(paramsOf(server, 'move.markMoved')[0]!.begunAt).toBeGreaterThanOrEqual(before);
    expect(paramsOf(server, 'move.abort')).toEqual([]);
    expect(paramsOf(remote, 'drafts.set')).toContainEqual({ key: 's1', text: 'half a thought' });
    expect(paramsOf(remote, 'chat.send')).toEqual([{ sessionId: 's1', text: noteFor() }]);
    expect(app.tabs.open).toEqual([`${M1}/s1`]);
    expect(app.tabs.active).toBe(`${M1}/s1`);
  });

  it('a folder picked in the dialog is the one the chat moves to', async () => {
    const { move, remote } = await start();
    await move.prepare(REF, M1, '/home/u/elsewhere');
    await move.run({ moveAnyway: false });
    expect(paramsOf(remote, 'move.commit')[0]!.cwd).toBe('/home/u/elsewhere');
  });

  it('exportPart failure aborts on the source and leaves the tab', async () => {
    const { move, server, remote, app } = await start({
      source: {
        'move.exportPart': () => {
          throw new RpcFail(MOVE_ERRORS.expired, 'This export is gone');
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });

    expect(move.state).toBe('failed');
    expect(move.problem).toBe('This export is gone');
    const { exportId } = paramsOf(server, 'move.exportBegin')[0]!;
    expect(paramsOf(server, 'move.abort')).toEqual([{ exportId }]);
    expect(remote.calls('move.commit')).toHaveLength(0);
    expect(server.calls('move.markMoved')).toHaveLength(0);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('a failed commit aborts too', async () => {
    const { move, server, app } = await start({
      target: {
        'move.commit': () => {
          throw new RpcFail('INTERNAL', 'disk full');
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('disk full');
    expect(server.calls('move.abort')).toHaveLength(1);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('a lost commit answer is asked again (commit is idempotent) and the move goes on', async () => {
    let lose = true;
    const { move, server, remote } = await start({
      target: {
        'move.commit': (p) => {
          if (lose) {
            lose = false;
            throw new RpcFail('TIMEOUT', 'no answer');
          }
          return { summary: summary('s1', { cwd: (p as P).cwd as string }) };
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(remote.calls('move.commit')).toHaveLength(2);
    expect(remote.calls('move.commit')[1]!.params).toEqual(remote.calls('move.commit')[0]!.params);
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(move.state).toBe('done');
  });

  it('a lost markMoved answer is asked again once the source answers', async () => {
    let lose = 2;
    const { move, server, app } = await start({
      source: {
        'move.markMoved': () => {
          if (lose-- > 0) throw new RpcFail('TIMEOUT', 'no answer');
          return {};
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    const calls = paramsOf(server, 'move.markMoved');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[0]);
    expect(move.oldCopyShown).toBe(false);
    expect(app.interaction.pendingMarks).toEqual({});
  });

  it('a source that never comes back: the old copy is still shown, kept in the app for the chat', async () => {
    vi.useFakeTimers({ toFake: FAKE });
    const { move, server, app } = await start({
      source: {
        'move.markMoved': () => {
          throw new RpcFail('DISCONNECTED', 'dropped');
        },
      },
    });
    // The source's link goes down with the first lost answer and stays down.
    let down = false;
    const local = app.machines.get(LOCAL)!;
    server.handlers['move.markMoved'] = () => {
      down = true;
      local.status = 'unreachable';
      throw new RpcFail('DISCONNECTED', 'dropped');
    };
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 10_000);
    await running;
    expect(down).toBe(true);
    expect(server.calls('move.markMoved')).toHaveLength(1);
    expect(move.oldCopyShown).toBe(true);
    expect(app.interaction.pendingMarks[`${M1}/s1`]).toMatchObject({
      source: LOCAL,
      exportId: paramsOf(server, 'move.exportBegin')[0]!.exportId,
      begunAt: expect.any(Number),
      to: { machineId: M1, name: 'Ubuntu PC' },
    });
  });

  it('markMoved failing sets oldCopyShown; retryMarkMoved clears it', async () => {
    let fail = true;
    const { move, server, remote, app } = await start({
      source: {
        'move.markMoved': () => {
          if (fail) throw new RpcFail('INTERNAL', 'db locked');
          return {};
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });

    // Not a lost answer: asked once, then Retry.
    expect(server.calls('move.markMoved')).toHaveLength(1);
    expect(move.oldCopyShown).toBe(true);
    expect(Object.keys(app.interaction.pendingMarks)).toEqual([`${M1}/s1`]);
    // The move is done all the same: the tab follows, the note goes.
    expect(move.state).toBe('done');
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(app.tabs.open).toEqual([`${M1}/s1`]);
    expect(remote.calls('chat.send')).toHaveLength(1);

    fail = false;
    await move.retryMarkMoved();
    expect(move.oldCopyShown).toBe(false);
    expect(app.interaction.pendingMarks).toEqual({});
    expect(server.calls('move.markMoved')).toHaveLength(2);
  });

  it('markMoved answering EXPIRED: failed, the tab stays and no note', async () => {
    const { move, server, remote, app } = await start({
      source: {
        'move.markMoved': () => {
          throw new RpcFail(MOVE_ERRORS.expired, 'This chat went on here');
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });

    expect(move.state).toBe('failed');
    expect(move.problem).toBe(
      'The move took too long and This PC went on with this chat, so it stays there. The copy on Ubuntu PC is left as it was.',
    );
    expect(move.oldCopyShown).toBe(false);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
    expect(remote.calls('chat.send')).toHaveLength(0);
    // A new move needs fresh checks.
    expect(move.check).toBeNull();
    await move.run({ moveAnyway: false });
    expect(server.calls('move.exportBegin')).toHaveLength(1);
  });

  it('retryMarkMoved answering EXPIRED: the tab goes back to the source, with the problem', async () => {
    let answer: 'fail' | 'expired' = 'fail';
    const { move, server, app } = await start({
      source: {
        'move.markMoved': () => {
          if (answer === 'fail') throw new RpcFail('INTERNAL', 'db locked');
          throw new RpcFail(MOVE_ERRORS.expired, 'This chat went on here');
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(move.oldCopyShown).toBe(true);
    expect(app.tabs.open).toEqual([`${M1}/s1`]);

    answer = 'expired';
    await move.retryMarkMoved();
    expect(move.oldCopyShown).toBe(false);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
    expect(app.tabs.active).toBe(`${LOCAL}/s1`);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe(
      'The move took too long and This PC went on with this chat, so it stays there. The copy on Ubuntu PC is left as it was.',
    );
    expect(move.check).toBeNull();
    await move.run({ moveAnyway: false });
    expect(server.calls('move.exportBegin')).toHaveLength(1);
  });

  it('retryMarkMoved answering EXPIRED brings the scheduled sends and the draft back to the source', async () => {
    let answer: 'fail' | 'expired' = 'fail';
    const { move, server, remote, app } = await start({
      source: {
        'move.markMoved': () => {
          if (answer === 'fail') throw new RpcFail('INTERNAL', 'db locked');
          throw new RpcFail(MOVE_ERRORS.expired, 'This chat went on here');
        },
        'scheduled.list': () => ({ items: [pending({ id: 'q1', text: 'go on' })] }),
        'scheduled.create': (p) => pending(p as Partial<ScheduledSend>),
        'drafts.set': () => ({}),
      },
      target: {
        'drafts.get': () => ({ text: 'typed there' }),
        'scheduled.cancel': () => ({}),
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(paramsOf(remote, 'scheduled.create').map((p) => p.id)).toEqual(['q1']);
    expect(paramsOf(server, 'scheduled.cancel')).toEqual([{ id: 'q1' }]);
    // On the target now: listed there.
    remote.handlers['scheduled.list'] = (p) =>
      (p as P).sessionId === 's1'
        ? { items: [pending({ id: 'q1', text: 'go on' })] }
        : { items: [] };

    answer = 'expired';
    await move.retryMarkMoved();

    // One home, the source: the send is there again and gone from the target.
    expect(paramsOf(server, 'scheduled.create')).toEqual([
      { sessionId: 's1', id: 'q1', text: 'go on', sendAt: expect.any(Number) },
    ]);
    expect(paramsOf(remote, 'scheduled.cancel')).toEqual([{ id: 'q1' }]);
    expect(paramsOf(server, 'drafts.set')).toContainEqual({ key: 's1', text: 'typed there' });
    expect(paramsOf(remote, 'drafts.set')).toContainEqual({ key: 's1', text: '' });
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
    expect(app.interaction.pendingMarks).toEqual({});
  });

  it('a source that cannot move: prepare refuses with the update text, asking nothing', async () => {
    const { move, log } = await start({ localMove: false });
    await move.prepare(REF, M1);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Update This PC to move chats there');
    expect(log).toEqual([]);
  });

  it('note failure leaves state noting; sendNoteAgain sends it', async () => {
    let fail = true;
    const { move, remote, app } = await start({
      target: {
        'chat.send': () => {
          if (fail) throw new RpcFail('RESUME_BLOCKED', 'Claude could not start');
          return { queued: false };
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });

    expect(move.state).toBe('noting');
    expect(move.problem).toBe('Claude could not start');
    expect(app.tabs.open).toEqual([`${M1}/s1`]);

    fail = false;
    await move.sendNoteAgain();
    expect(move.state).toBe('done');
    expect(move.problem).toBeNull();
    expect(paramsOf(remote, 'chat.send')).toEqual([
      { sessionId: 's1', text: noteFor() },
      { sessionId: 's1', text: noteFor() },
    ]);
  });

  it('Off target with power: turnOn then waits for on, then moves', async () => {
    // Before the start: the relay client's reconnect backoff must be on the fake clock too.
    vi.useFakeTimers({ toFake: FAKE });
    const { move, log, app } = await start({ off: true, power: true });
    await vi.waitFor(() => expect(shownOf(app)).toBe('off'));
    await move.prepare(REF, M1);
    expect(move.state).toBe('ready');
    expect(move.check?.target).toBeNull();

    const running = move.run({ moveAnyway: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(move.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    expect(move.state).toBe('done');
    expect(log.slice(0, 4)).toEqual([
      'source move.check',
      'power power.turnOn',
      'target move.target',
      'source move.exportBegin',
    ]);
    expect(app.tabs.open).toEqual([`${M1}/s1`]);
  });

  it('Off target that never comes up: fails after 10 min (fake timers) and aborts', async () => {
    vi.useFakeTimers({ toFake: FAKE });
    const { move, server, app } = await start({ off: true, power: true, comesUp: false });
    await vi.waitFor(() => expect(shownOf(app)).toBe('off'));
    await move.prepare(REF, M1);

    const running = move.run({ moveAnyway: false });
    await vi.advanceTimersByTimeAsync(START_WAIT_MS - 60_000);
    expect(move.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(61_000);
    await running;

    expect(START_WAIT_MS).toBe(10 * 60_000);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe("Ubuntu PC didn't come up in 10 minutes");
    expect(server.calls('power.turnOn')).toHaveLength(1);
    expect(server.calls('move.exportBegin')).toHaveLength(0);
    // The source is unlocked all the same (Review Focus 5).
    expect(paramsOf(server, 'move.abort')).toEqual([{ exportId: expect.any(String) }]);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('Off target without power control: refused, no call to exportBegin', async () => {
    const { move, log, server, app } = await start({ off: true });
    expect(app.machines.get(M1)?.status).not.toBe('on');
    await move.prepare(REF, M1);
    log.length = 0;
    await move.run({ moveAnyway: false });

    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Ubuntu PC is off');
    expect(log).toEqual([]);
    expect(server.calls('power.turnOn')).toHaveLength(0);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('a target whose service cannot move: prepare refuses with the update text, asking nothing', async () => {
    const { move, log, app } = await start();
    app.machines.get(M1)!.info!.capabilities = ['remote'];
    await move.prepare(REF, M1);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Update Ubuntu PC to move chats there');
    expect(log).toEqual([]);
    await move.run({ moveAnyway: false });
    expect(log).toEqual([]);
  });

  it('a target that turns out not to move when run: refused with the update text, and aborted', async () => {
    const { move, server, app } = await start();
    await move.prepare(REF, M1);
    app.machines.get(M1)!.info!.capabilities = ['remote'];
    await move.run({ moveAnyway: false });
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Update Ubuntu PC to move chats there');
    expect(server.calls('move.exportBegin')).toHaveLength(0);
    expect(server.calls('move.abort')).toHaveLength(1);
  });

  it('a second run during a run is refused', async () => {
    const { move, server, remote } = await start();
    await move.prepare(REF, M1);
    const first = move.run({ moveAnyway: false });
    const second = move.run({ moveAnyway: false });
    expect(move.state).toBe('moving');
    await Promise.all([first, second]);
    expect(server.calls('move.exportBegin')).toHaveLength(1);
    expect(remote.calls('move.commit')).toHaveLength(1);
    expect(move.state).toBe('done');
  });

  it('prepare during a run is ignored', async () => {
    const { move, server, remote } = await start();
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    await move.prepare(REF, M1, '/home/u/elsewhere');
    await running;
    expect(server.calls('move.check')).toHaveLength(1);
    expect(paramsOf(remote, 'move.commit')[0]!.cwd).toBe(TARGET_FOLDER);
    expect(move.state).toBe('done');
  });

  it('askToPush during a run is ignored', async () => {
    const { move, server } = await start();
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    await move.askToPush(REF);
    await running;
    expect(server.calls('chat.send')).toHaveLength(0);
    expect(move.state).toBe('done');
  });

  it('abandon while the target starts: no exportBegin, failed with Move cancelled', async () => {
    vi.useFakeTimers({ toFake: FAKE });
    const { move, server, app } = await start({ off: true, power: true });
    await vi.waitFor(() => expect(shownOf(app)).toBe('off'));
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    expect(move.state).toBe('starting');
    move.abandon();
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Move cancelled');
    await vi.advanceTimersByTimeAsync(30_000);
    await running;
    expect(app.machines.get(M1)?.status).toBe('on');
    expect(server.calls('move.exportBegin')).toHaveLength(0);
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Move cancelled');
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('abandon during the export: abort sent, nothing imported', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { move, server, remote, app } = await start({
      source: {
        'move.exportPart': async (p) => {
          await held;
          return { keys: [{ entries: [{ type: 'user', part: (p as P).index }] }] };
        },
      },
    });
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    await vi.waitFor(() => expect(server.calls('move.exportPart')).toHaveLength(1));
    move.abandon();
    const { exportId } = paramsOf(server, 'move.exportBegin')[0]!;
    await vi.waitFor(() => expect(paramsOf(server, 'move.abort')).toContainEqual({ exportId }));
    release();
    await running;
    expect(remote.calls('move.importPart')).toHaveLength(0);
    expect(remote.calls('move.commit')).toHaveLength(0);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Move cancelled');
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('a lost exportBegin answer is asked again with the same exportId and the move completes', async () => {
    let lose = true;
    const { move, server } = await start({
      source: {
        'move.exportBegin': (p) => {
          if (lose) {
            lose = false;
            throw new RpcFail('TIMEOUT', 'no answer');
          }
          return { exportId: (p as P).exportId, parts: 2, bytes: 100 };
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    const begins = paramsOf(server, 'move.exportBegin');
    expect(begins).toHaveLength(2);
    expect(begins[1]).toEqual(begins[0]);
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(move.state).toBe('done');
  });

  it('lost exportPart and importPart answers are asked again with the same ids', async () => {
    let loseExport = true;
    let loseImport = true;
    const { move, server, remote } = await start({
      source: {
        'move.exportPart': (p) => {
          if (loseExport) {
            loseExport = false;
            throw new RpcFail('DISCONNECTED', 'dropped');
          }
          return { keys: [{ entries: [{ type: 'user', part: (p as P).index }] }] };
        },
      },
      target: {
        'move.importPart': () => {
          if (loseImport) {
            loseImport = false;
            throw new RpcFail('TIMEOUT', 'no answer');
          }
          return {};
        },
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    const parts = paramsOf(server, 'move.exportPart');
    expect(parts.map((p) => p.index)).toEqual([0, 0, 1]);
    const imports = paramsOf(remote, 'move.importPart');
    expect(imports.map((p) => p.index)).toEqual([0, 0, 1]);
    expect(imports[1]).toEqual(imports[0]);
    expect(move.state).toBe('done');
  });

  it('a commit cut off by a dropped target link is asked again once it is back', async () => {
    let first = true;
    const link: { remote?: FakeServer } = {};
    const env = await start({
      target: {
        'move.commit': (p) => {
          if (first) {
            first = false;
            link.remote!.drop();
            return new Promise(() => {});
          }
          return { summary: summary('s1', { cwd: (p as P).cwd as string }) };
        },
      },
    });
    link.remote = env.remote;
    const { move, server, remote, app } = env;
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    const commits = paramsOf(remote, 'move.commit');
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(commits[0]);
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(move.state).toBe('done');
    expect(app.tabs.open).toEqual([`${M1}/s1`]);
  });

  it('a commit whose target stays unreachable: aborted, the move may have reached it', async () => {
    vi.useFakeTimers({ toFake: FAKE });
    const link: { remote?: FakeServer } = {};
    const env = await start({
      target: {
        'move.commit': () => {
          link.remote!.refuse = true;
          link.remote!.drop();
          return new Promise(() => {});
        },
      },
    });
    link.remote = env.remote;
    const { move, server, remote, app } = env;
    await move.prepare(REF, M1);
    const running = move.run({ moveAnyway: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 10_000);
    await running;
    expect(remote.calls('move.commit')).toHaveLength(1);
    expect(server.calls('move.abort')).toHaveLength(1);
    expect(move.state).toBe('failed');
    expect(move.problem).toBe(
      'The move may have reached Ubuntu PC; check there before moving again.',
    );
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });

  it('a scheduled send the source will not cancel is cancelled on the target again', async () => {
    const { move, server, remote } = await start({
      source: {
        'scheduled.list': () => ({ items: [pending({ id: 'q1', afterLimitReset: true })] }),
        'scheduled.cancel': () => {
          throw new RpcFail('INTERNAL', 'db locked');
        },
      },
      target: { 'scheduled.cancel': () => ({}) },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(paramsOf(remote, 'scheduled.create')).toHaveLength(1);
    expect(paramsOf(server, 'scheduled.cancel')).toEqual([
      { id: 'q1' },
      { id: 'q1' },
      { id: 'q1' },
    ]);
    expect(paramsOf(remote, 'scheduled.cancel')).toEqual([{ id: 'q1' }]);
    expect(move.state).toBe('done');
  });

  it('a waiting-for-reset send is recreated with whenLimitResets on the target', async () => {
    const at = Date.now() + 7_200_000;
    const { move, server, remote } = await start({
      source: {
        'scheduled.list': () => ({
          items: [
            pending({ id: 'q1', text: 'go on', afterLimitReset: true }),
            pending({ id: 'q2', text: 'later', sendAt: at }),
            pending({ id: 'q3', text: 'stuck', state: 'failed' }),
          ],
        }),
      },
    });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });

    expect(paramsOf(remote, 'scheduled.create')).toEqual([
      { sessionId: 's1', id: 'q1', text: 'go on', whenLimitResets: true },
      { sessionId: 's1', id: 'q2', text: 'later', sendAt: at },
    ]);
    expect(paramsOf(server, 'scheduled.cancel')).toEqual([{ id: 'q1' }, { id: 'q2' }]);
  });

  it('a dirty project moves only with moveAnyway, and the note says what stayed', async () => {
    const dirty: GitState = {
      kind: 'dirty',
      branch: 'main',
      origin: ORIGIN,
      changed: 3,
      unpushed: 2,
    };
    const { move, server, remote } = await start({ git: dirty });
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('3 changed files · 2 commits not pushed on main');
    expect(server.calls('move.exportBegin')).toHaveLength(0);

    await move.run({ moveAnyway: true });
    expect(move.state).toBe('done');
    expect(paramsOf(remote, 'chat.send')).toEqual([
      {
        sessionId: 's1',
        text: noteFor({ leftBehind: '3 changed files · 2 commits not pushed on main' }),
      },
    ]);
  });

  it('askToPush sends the request in the chat and moves nothing', async () => {
    const dirty: GitState = {
      kind: 'dirty',
      branch: 'fix/usage',
      origin: ORIGIN,
      changed: 1,
      unpushed: 0,
    };
    const { move, server, remote, app } = await start({ git: dirty });
    await move.prepare(REF, M1);
    await move.askToPush(REF);

    expect(paramsOf(server, 'chat.send')).toEqual([
      {
        sessionId: 's1',
        text: "Please commit your work and push it to its branch (fix/usage), so this chat can move to Ubuntu PC. If it isn't ready for that branch, push it to a new WIP branch instead and tell me its name.",
      },
    ]);
    expect(server.calls('move.exportBegin')).toHaveLength(0);
    expect(remote.calls('move.commit')).toHaveLength(0);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
  });
});

describe('a source that is away', () => {
  it('a markMoved asked while the source is away is asked again once it is back', async () => {
    const { app, remote } = await setupTwoMachines({
      configureRemote: (s) => (s.handlers['move.markMoved'] = () => ({})),
    });
    apps.push(app);
    remote.refuse = true;
    remote.drop();
    await vi.waitFor(() => expect(app.machines.get(M1)?.status).toBe('unreachable'));
    // Asked now, it is answered by the copy here (AWAY), not by the machine.
    const marked = markOldCopy(
      app,
      { machineId: LOCAL, sessionId: 's1' },
      {
        source: M1,
        exportId: 'e1',
        begunAt: 1,
        to: { machineId: LOCAL, name: 'This PC' },
        problem: null,
      },
      { retryMs: 0 },
    );
    await new Promise((r) => setTimeout(r, 50));
    remote.refuse = false;
    expect(await marked).toBe('done');
    expect(remote.calls('move.markMoved')).toHaveLength(1);
    expect(app.interaction.pendingMarks).toEqual({});
  }, 20_000);
});

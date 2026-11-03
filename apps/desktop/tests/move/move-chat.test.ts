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
import { MoveChat, START_WAIT_MS } from '../../src/lib/move/move-chat.svelte';
import { moveNote } from '../../src/lib/move/note';
import type { AppState } from '../../src/lib/state/context';
import { LOCAL, M1, setupTwoMachines, summary } from '../layout/harness';
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
    expect(paramsOf(server, 'move.markMoved')).toEqual([
      { exportId, to: { machineId: M1, name: 'Ubuntu PC' } },
    ]);
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

  it('markMoved failing 3× sets oldCopyShown; retryMarkMoved clears it', async () => {
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

    expect(server.calls('move.markMoved')).toHaveLength(3);
    expect(move.oldCopyShown).toBe(true);
    // The move is done all the same: the tab follows, the note goes.
    expect(move.state).toBe('done');
    expect(server.calls('move.abort')).toHaveLength(0);
    expect(app.tabs.open).toEqual([`${M1}/s1`]);
    expect(remote.calls('chat.send')).toHaveLength(1);

    fail = false;
    await move.retryMarkMoved();
    expect(move.oldCopyShown).toBe(false);
    expect(server.calls('move.markMoved')).toHaveLength(4);
  });

  it('markMoved answering EXPIRED: failed, the tab stays and no note', async () => {
    const { move, remote, app } = await start({
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
    expect(server.calls('move.abort')).toHaveLength(1);
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

  it('a target whose service cannot move: refused with the update text, and aborted', async () => {
    const { move, server, app } = await start();
    app.machines.get(M1)!.info!.capabilities = ['remote'];
    await move.prepare(REF, M1);
    await move.run({ moveAnyway: false });
    expect(move.state).toBe('failed');
    expect(move.problem).toBe('Update Ubuntu PC to move chats there');
    expect(server.calls('move.exportBegin')).toHaveLength(0);
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

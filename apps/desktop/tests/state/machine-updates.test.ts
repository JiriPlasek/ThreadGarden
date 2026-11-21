import { UPDATE_ERRORS, type UpdateStage, type UpdateStatus } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_WAIT_MS } from '../../src/lib/move/move-chat.svelte';
import { RequestError, type ClientStatus } from '../../src/lib/service/client';
import { MachineUpdatesState } from '../../src/lib/state/machine-updates.svelte';
import type { MachineEntry, MachineStatus } from '../../src/lib/state/machines.svelte';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from '../../src/lib/state/updates.svelte';

const ID = 'm1';
const FROM = '0.7.0';
const LATEST = '0.8.0';

type Method = (params: never) => unknown;

/** A machine's client: requests answer from `methods` while it is open. */
const fakeClient = (status: ClientStatus, methods: Record<string, Method>) => {
  const listeners = new Map<string, Set<(data: never) => void>>();
  const statusCbs = new Set<(s: ClientStatus) => void>();
  const openCbs = new Set<() => void>();
  const c = {
    status,
    request: vi.fn(async (method: string, params: never) => {
      if (c.status !== 'open') throw new RequestError('DISCONNECTED', 'Not connected');
      const answer = methods[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params);
    }),
    on: (event: string, cb: (data: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(cb);
      return () => set.delete(cb);
    },
    onStatus: (cb: (s: ClientStatus) => void) => {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    onOpen: (cb: () => void) => {
      openCbs.add(cb);
      return () => openCbs.delete(cb);
    },
    close: vi.fn(() => {
      c.status = 'closed';
    }),
    emit: (event: string, data: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(data as never);
    },
    /** The link changes, as the real client tells it. */
    link: (s: ClientStatus) => {
      c.status = s;
      for (const cb of statusCbs) cb(s);
      if (s === 'open') for (const cb of openCbs) cb();
    },
  };
  return c;
};
type FakeClient = ReturnType<typeof fakeClient>;

const flush = () => vi.advanceTimersByTimeAsync(0);

let state: MachineUpdatesState;

/** One paired machine and what it answers. */
const rig = async (
  o: {
    status?: MachineStatus;
    shown?: MachineStatus;
    link?: ClientStatus;
    version?: string | null;
    canUpdate?: boolean;
    latest?: string | null;
    service?: UpdateStatus;
    /** False: paired only later. */
    paired?: boolean;
    local?: boolean;
  } = {},
) => {
  const service: {
    status: UpdateStatus;
    start: { started: true } | { started: false; busy: number } | Error;
  } = { status: o.service ?? { state: 'idle' }, start: { started: true } };
  const starts: { version: string; force: boolean }[] = [];
  const methods: Record<string, Method> = {
    'update.status': () => service.status,
    'update.start': (p: { version: string; force: boolean }) => {
      starts.push(p);
      if (service.start instanceof Error) throw service.start;
      if (service.start.started) {
        service.status = { state: 'running', version: p.version, from: FROM, stage: 'downloading' };
      }
      return service.start;
    },
  };
  const status = o.status ?? 'on';
  const client = fakeClient(o.link ?? (status === 'on' ? 'open' : 'reconnecting'), methods);
  const m = {
    id: ID,
    name: 'Ubuntu PC',
    local: o.local ?? false,
    status,
    shownAs: o.shown ?? null,
    // This PC's entry never knows its version.
    version: o.local ? null : o.version === undefined ? FROM : o.version,
    canUpdate: o.canUpdate ?? !o.local,
    client,
    info: null as MachineEntry['info'],
  };
  const sides: FakeClient[] = [];
  const reach = { side: true };
  let added: (e: MachineEntry) => void = () => {};
  let removed: (id: string) => void = () => {};
  const machines = {
    list: (o.paired === false ? [] : [m]) as unknown as MachineEntry[],
    get: (id: string) =>
      machines.list.length > 0 && id === ID ? (m as unknown as MachineEntry) : undefined,
    shown: () => m.shownAs ?? m.status,
    onAdded: (cb: (e: MachineEntry) => void) => {
      added = cb;
      return () => {};
    },
    onRemoved: (cb: (id: string) => void) => {
      removed = cb;
      return () => {};
    },
    added: (e: MachineEntry) => {
      machines.list.push(e);
      added(e);
    },
    removed: (id: string) => {
      machines.list.length = 0;
      removed(id);
    },
    openForUpdate: vi.fn(async () => {
      if (!reach.side) throw new RequestError('DISCONNECTED', 'Connection closed');
      const side = fakeClient('open', methods);
      sides.push(side);
      return side as never;
    }),
    reconnect: vi.fn(),
  };
  const power = { turnOn: vi.fn(async () => true), error: vi.fn(() => null as string | null) };
  const latest = { answer: (o.latest === undefined ? LATEST : o.latest) as string | null | Error };
  const api = {
    request: vi.fn(async () => {
      if (latest.answer instanceof Error) throw latest.answer;
      return { version: latest.answer };
    }),
  };
  state = new MachineUpdatesState();
  state.init({ api: api as never, machines: machines as never, power });
  if (o.latest !== null) await state.refresh({ force: true });
  await flush();
  return { state, m, client, service, starts, sides, reach, machines, power, api, latest };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  state?.dispose();
  vi.useRealTimers();
});

describe('MachineUpdatesState: versions', () => {
  it('behind needs a known version, a known latest, an older version and canUpdate', async () => {
    const { state } = await rig();
    const entry = (version: string | null, canUpdate = true) => ({ version, canUpdate });
    expect(state.behind(entry(FROM))).toBe(true);
    expect(state.behind(entry(null))).toBe(false);
    expect(state.behind(entry(LATEST))).toBe(false);
    expect(state.behind(entry('0.9.0'))).toBe(false);
    expect(state.behind(entry(FROM, false))).toBe(false);

    state.latest = null;
    expect(state.behind(entry(FROM))).toBe(false);
  });

  it('tooOld is a known version that cannot update itself', async () => {
    const { state } = await rig();
    expect(state.tooOld({ version: FROM, canUpdate: false })).toBe(true);
    expect(state.tooOld({ version: FROM, canUpdate: true })).toBe(false);
    expect(state.tooOld({ version: null, canUpdate: false })).toBe(false);
  });

  it('anyBehind follows the machines', async () => {
    const { state, m } = await rig();
    expect(state.anyBehind).toBe(true);
    m.version = LATEST;
    expect(state.anyBehind).toBe(false);
  });
});

describe('MachineUpdatesState: the latest release', () => {
  it('checks 10 s after start, then every 6 hours', async () => {
    const { state, api, latest } = await rig({ latest: null });
    latest.answer = LATEST;
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(api.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.request).toHaveBeenCalledWith('update.latest', {});
    expect(state.latest).toBe(LATEST);

    latest.answer = '0.9.0';
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(state.latest).toBe(LATEST);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.latest).toBe('0.9.0');
  });

  it('an unreachable latest check shows nothing and retries on schedule', async () => {
    const { state, latest } = await rig({ latest: null });
    latest.answer = new RequestError(UPDATE_ERRORS.UNREACHABLE, 'GitHub did not answer');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(state.latest).toBeNull();

    latest.answer = LATEST;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(state.latest).toBe(LATEST);

    // A later failure keeps what is known.
    latest.answer = new RequestError(UPDATE_ERRORS.UNREACHABLE, 'GitHub did not answer');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(state.latest).toBe(LATEST);
  });

  it('refresh asks again only when the last answer is older than 10 minutes', async () => {
    const { state, api } = await rig();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    api.request.mockClear();
    await state.refresh();
    expect(api.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    await state.refresh();
    expect(api.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await state.refresh();
    expect(api.request).toHaveBeenCalledTimes(1);

    await state.refresh({ force: true });
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it('refresh without an answer so far asks; a failure does not count as an answer', async () => {
    const { state, api, latest } = await rig({ latest: null });
    latest.answer = new Error('down');
    await state.refresh();
    await state.refresh();
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(state.latest).toBeNull();
  });
});

describe('MachineUpdatesState: starting an update', () => {
  it('prepare returns busy count from update.start force=false', async () => {
    const { state, service, starts } = await rig();
    service.start = { started: false, busy: 2 };

    await expect(state.prepare(ID)).resolves.toEqual({ busy: 2 });

    expect(starts).toEqual([{ version: LATEST, force: false }]);
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toBeNull();
  });

  it('prepare with nothing busy has already started: null, and the first stage shows', async () => {
    const { state, starts } = await rig();

    await expect(state.prepare(ID)).resolves.toBeNull();

    expect(starts).toEqual([{ version: LATEST, force: false }]);
    expect(state.stage(ID)).toBe('downloading');
  });

  it('update is the force=true call after the prompt', async () => {
    const { state, service, starts } = await rig();
    service.start = { started: false, busy: 1 };
    await state.prepare(ID);

    service.start = { started: true };
    await state.update(ID);

    expect(starts.at(-1)).toEqual({ version: LATEST, force: true });
    expect(state.stage(ID)).toBe('downloading');
  });

  it('without a known latest release nothing starts', async () => {
    const { state, starts } = await rig({ latest: null });

    await expect(state.prepare(ID)).resolves.toBeNull();
    await state.update(ID);

    expect(starts).toEqual([]);
    expect(state.stage(ID)).toBeNull();
  });

  it('a machine that is not behind is not updated', async () => {
    const { state, starts } = await rig({ version: LATEST });

    await state.update(ID);

    expect(starts).toEqual([]);
  });

  it('a second press while one is starting or running does nothing', async () => {
    const { state, starts } = await rig();

    const first = state.prepare(ID);
    await expect(state.prepare(ID)).resolves.toBeNull();
    await first;
    await state.update(ID);

    expect(starts).toEqual([{ version: LATEST, force: false }]);
  });

  it('a start the machine refuses is a failure with its reason; it can be tried again', async () => {
    const { state, service, starts } = await rig();
    service.start = new RequestError(UPDATE_ERRORS.NOT_SUPPORTED, 'This machine cannot update');

    await expect(state.prepare(ID)).resolves.toBeNull();

    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual({
      state: 'failed',
      version: LATEST,
      from: FROM,
      reason: 'start',
      detail: 'This machine cannot update',
    });

    service.start = { started: true };
    await state.prepare(ID);
    expect(starts).toHaveLength(2);
    expect(state.stage(ID)).toBe('downloading');
    expect(state.outcome(ID)).toBeNull();
  });

  it('ALREADY_CURRENT is no failure: the machine got there some other way', async () => {
    const { state, service } = await rig();
    service.start = new RequestError(UPDATE_ERRORS.ALREADY_CURRENT, 'Already runs it');

    await expect(state.prepare(ID)).resolves.toBeNull();

    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toBeNull();
  });
});

describe('MachineUpdatesState: an Off machine', () => {
  const off = { status: 'unreachable', shown: 'off' } as const;
  const comesUp = (r: Awaited<ReturnType<typeof rig>>) => {
    r.m.status = 'on';
    r.m.shownAs = null;
    r.client.link('open');
  };

  it('an Off machine with power is turned on first', async () => {
    const r = await rig(off);
    expect(state.canStart(r.m as never)).toBe(true);

    const running = state.prepare(ID);
    await flush();
    expect(r.power.turnOn).toHaveBeenCalledWith(ID);
    expect(state.stage(ID)).toBe('turningOn');
    expect(r.starts).toEqual([]);

    comesUp(r);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toBeNull();
    expect(r.starts).toEqual([{ version: LATEST, force: false }]);
    expect(state.stage(ID)).toBe('downloading');
  });

  it('without power update is not offered', async () => {
    const r = await rig({ status: 'unreachable' });
    expect(state.canStart(r.m as never)).toBe(false);

    await expect(state.prepare(ID)).resolves.toBeNull();
    await state.update(ID);

    expect(r.power.turnOn).not.toHaveBeenCalled();
    expect(r.machines.openForUpdate).not.toHaveBeenCalled();
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toBeNull();
  });

  it('a machine already starting is waited for, not turned on again', async () => {
    const r = await rig({ status: 'unreachable', shown: 'starting' });
    const running = state.prepare(ID);
    await flush();
    expect(state.stage(ID)).toBe('turningOn');

    comesUp(r);
    await vi.advanceTimersByTimeAsync(1_000);
    await running;

    expect(r.power.turnOn).not.toHaveBeenCalled();
    expect(r.starts).toHaveLength(1);
  });

  it('busy after coming up asks first, with no stage left showing', async () => {
    const r = await rig(off);
    r.service.start = { started: false, busy: 3 };
    const running = state.prepare(ID);
    await flush();
    comesUp(r);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(running).resolves.toEqual({ busy: 3 });
    expect(state.stage(ID)).toBeNull();
  });

  it('a Turn on that fails is a failure in the power error words', async () => {
    const r = await rig(off);
    r.power.turnOn.mockResolvedValue(false);
    r.power.error.mockReturnValue("The power switch can't be reached.");

    await expect(state.prepare(ID)).resolves.toBeNull();

    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual({
      state: 'failed',
      version: LATEST,
      from: FROM,
      reason: 'start',
      detail: "The power switch can't be reached.",
    });
  });

  it('a machine that never comes up fails after 10 minutes', async () => {
    await rig(off);
    const running = state.prepare(ID);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000);
    expect(state.stage(ID)).toBe('turningOn');
    await vi.advanceTimersByTimeAsync(1_000);
    await running;

    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toMatchObject({
      state: 'failed',
      reason: 'start',
      detail: "Ubuntu PC didn't come up in 10 minutes",
    });
  });

  it('a machine whose fresh hello says it is up to date is left alone', async () => {
    const r = await rig(off);
    const running = state.prepare(ID);
    await flush();
    r.m.version = LATEST;
    comesUp(r);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(running).resolves.toBeNull();
    expect(r.starts).toEqual([]);
    expect(state.stage(ID)).toBeNull();
  });
});

describe('MachineUpdatesState: following an update', () => {
  const running = (stage: UpdateStage): UpdateStatus => ({
    state: 'running',
    version: LATEST,
    from: FROM,
    stage,
  });
  const done: UpdateStatus = { state: 'done', version: LATEST, from: FROM, skipped: [] };
  const failed: UpdateStatus = { state: 'failed', version: LATEST, from: FROM, reason: 'start' };
  const drop = (r: Awaited<ReturnType<typeof rig>>) => {
    r.m.status = 'unreachable';
    r.client.link('reconnecting');
  };
  const back = (r: Awaited<ReturnType<typeof rig>>) => {
    r.m.status = 'on';
    r.client.link('open');
  };
  /** Started and following: the machine says `stage`. */
  const started = async (stage: UpdateStage = 'downloading') => {
    const r = await rig();
    await state.prepare(ID);
    r.service.status = running(stage);
    await vi.advanceTimersByTimeAsync(2_000);
    return r;
  };

  it('follows downloading → installing → restarting, then reads done after reconnect', async () => {
    const r = await started();
    expect(state.stage(ID)).toBe('downloading');

    r.service.status = running('installing');
    r.client.emit('update.progress', running('installing'));
    expect(state.stage(ID)).toBe('installing');

    r.service.status = running('restarting');
    r.client.emit('update.progress', running('restarting'));
    expect(state.stage(ID)).toBe('restarting');

    drop(r);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.stage(ID)).toBe('restarting');

    r.service.status = done;
    r.m.version = LATEST;
    back(r);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual(done);
    expect(state.behind(r.m)).toBe(false);
  });

  it('a failure the machine reports ends it, with no more asking', async () => {
    const r = await started();
    r.service.status = failed;
    r.client.emit('update.progress', failed);
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual(failed);

    r.client.request.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.client.request).not.toHaveBeenCalled();
  });

  it('keeps asking while the reconnected machine reads running: its event can be dropped', async () => {
    const r = await started('restarting');
    drop(r);
    await vi.advanceTimersByTimeAsync(10_000);
    back(r);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.stage(ID)).toBe('restarting');

    // The rollback is over, and nobody says so but the status.
    r.service.status = failed;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual(failed);
  });

  it.each(['linux', 'win32'] as const)(
    'a %s machine that never comes back names the recovery method',
    async (platform) => {
      const r = await started('restarting');
      r.m.info = {
        id: ID,
        name: 'Ubuntu PC',
        platform,
        headless: true,
        home: '/home/test',
        capabilities: [],
      };
      const limit = RECONNECT_WAIT_MS + 90_000;
      drop(r);
      await vi.advanceTimersByTimeAsync(limit - 5_000);
      expect(state.stage(ID)).toBe('restarting');
      expect(state.outcome(ID)).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.stage(ID)).toBeNull();
      expect(state.outcome(ID)).toEqual({
        state: 'failed',
        version: LATEST,
        from: FROM,
        reason: 'start',
        detail: `Ubuntu PC hasn't come back since it began updating to ${LATEST}. It may need a look over ${platform === 'win32' ? 'Remote Desktop' : 'SSH'}.`,
      });
    },
  );

  it('a machine stuck reading running gets the same limit', async () => {
    await started('restarting');
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 90_000);
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toMatchObject({ state: 'failed', reason: 'start' });
  });

  it('a download takes as long as it takes', async () => {
    await started('downloading');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(state.stage(ID)).toBe('downloading');
    expect(state.outcome(ID)).toBeNull();
  });

  it('a link lost mid-download that comes back starts the limit over', async () => {
    const r = await started('downloading');
    drop(r);
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);
    back(r);
    await vi.advanceTimersByTimeAsync(2_000);
    drop(r);
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS);
    expect(state.stage(ID)).toBe('downloading');
    expect(state.outcome(ID)).toBeNull();
  });

  it('UPDATE_RUNNING follows the running update', async () => {
    const r = await rig();
    r.service.start = new RequestError(UPDATE_ERRORS.UPDATE_RUNNING, 'An update is running');
    r.service.status = running('installing');

    await expect(state.prepare(ID)).resolves.toBeNull();
    await flush();

    expect(state.stage(ID)).toBe('installing');
    expect(state.outcome(ID)).toBeNull();

    r.service.status = done;
    r.m.version = LATEST;
    r.client.emit('update.progress', done);
    expect(state.stage(ID)).toBeNull();
    expect(state.outcome(ID)).toEqual(done);
  });

  it("UPDATE_RUNNING's limit and failure name the update that is really running", async () => {
    const r = await rig();
    r.service.start = new RequestError(UPDATE_ERRORS.UPDATE_RUNNING, 'An update is running');
    r.service.status = { state: 'running', version: '0.7.5', from: '0.6.0', stage: 'restarting' };
    await state.prepare(ID);
    await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 90_000);
    expect(state.outcome(ID)).toMatchObject({ state: 'failed', version: '0.7.5', from: '0.6.0' });
  });

  describe('what the machine says when nobody pressed anything', () => {
    it("restores a finished update's outcome after a desktop restart", async () => {
      await rig({ service: done, version: LATEST });
      expect(state.outcome(ID)).toEqual(done);
      expect(state.stage(ID)).toBeNull();
    });

    it('a failure for a version the machine has since reached is not shown', async () => {
      // Updated by hand after a rollback: `last.json` still says it failed, and nothing clears it.
      const r = await rig({ service: failed, version: LATEST });
      expect(state.outcome(ID)).toBeNull();

      r.m.version = '0.9.0';
      expect(state.outcome(ID)).toBeNull();
    });

    it('a failure stops showing as soon as the machine reaches its version', async () => {
      const r = await rig({ service: failed });
      expect(state.outcome(ID)).toEqual(failed);

      r.m.version = LATEST;
      expect(state.outcome(ID)).toBeNull();
    });

    it('a done for another version is not shown', async () => {
      const r = await rig({ service: done, version: '0.9.0' });
      expect(state.outcome(ID)).toBeNull();

      r.m.version = FROM;
      expect(state.outcome(ID)).toBeNull();
    });

    it("a real rollback's failure still shows while the machine is older", async () => {
      const r = await rig({ service: failed });
      expect(r.m.version).toBe(FROM);
      expect(state.outcome(ID)).toEqual(failed);
    });

    it("a done for the machine's own version still shows after a desktop restart", async () => {
      await rig({ service: done, version: LATEST });
      expect(state.outcome(ID)).toEqual(done);
    });

    it('reads the outcome on each reconnect', async () => {
      const r = await rig({ status: 'unreachable' });
      expect(state.outcome(ID)).toBeNull();

      r.service.status = failed;
      back(r);
      await flush();
      expect(state.outcome(ID)).toEqual(failed);

      // The machine forgot it, e.g. a fresh install.
      drop(r);
      r.service.status = { state: 'idle' };
      back(r);
      await flush();
      expect(state.outcome(ID)).toBeNull();
    });

    it('a desktop restarted mid-update follows it to the end', async () => {
      const r = await rig({ service: running('installing') });
      expect(state.stage(ID)).toBe('installing');

      r.service.status = done;
      r.m.version = LATEST;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.stage(ID)).toBeNull();
      expect(state.outcome(ID)).toEqual(done);
    });

    it('an update another desktop started shows from its first event', async () => {
      const r = await rig();
      r.service.status = running('downloading');
      r.client.emit('update.progress', running('downloading'));
      expect(state.stage(ID)).toBe('downloading');
    });

    it('a machine back after the limit replaces the failure with what happened', async () => {
      const r = await started('restarting');
      drop(r);
      await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 90_000);
      expect(state.outcome(ID)).toMatchObject({ state: 'failed', detail: expect.any(String) });

      r.service.status = done;
      r.m.version = LATEST;
      back(r);
      await flush();
      expect(state.outcome(ID)).toEqual(done);
    });

    it('a machine too old for updates is not asked', async () => {
      const r = await rig({ canUpdate: false, service: done });
      expect(r.client.request).not.toHaveBeenCalled();
      expect(state.outcome(ID)).toBeNull();
    });

    it('a reconnect during a followed update changes nothing by itself', async () => {
      const r = await started('downloading');
      drop(r);
      r.service.status = done;
      back(r);
      await flush();
      r.service.status = running('downloading');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.stage(ID)).toBe('downloading');
    });

    it('a machine turning on and answering does not disturb the start', async () => {
      const r = await rig({ status: 'unreachable', shown: 'off', service: failed });
      const pressed = state.prepare(ID);
      await flush();
      r.service.status = { state: 'idle' };
      r.m.status = 'on';
      r.m.shownAs = null;
      r.client.link('open');
      await flush();
      expect(state.stage(ID)).toBe('turningOn');

      await vi.advanceTimersByTimeAsync(1_000);
      await pressed;
      expect(state.stage(ID)).toBe('downloading');
    });

    it('follows a machine paired later, and forgets a removed one', async () => {
      const r = await rig({ service: done, version: LATEST, paired: false });
      expect(state.outcome(ID)).toBeNull();

      r.machines.added(r.m as never);
      await flush();
      expect(state.outcome(ID)).toEqual(done);

      r.machines.removed(ID);
      expect(state.outcome(ID)).toBeNull();
      r.client.emit('update.progress', running('downloading'));
      expect(state.stage(ID)).toBeNull();
    });

    it("This PC's entry is not followed", async () => {
      const r = await rig({ service: done, local: true });
      expect(r.client.request).not.toHaveBeenCalled();
      expect(state.anyBehind).toBe(false);
    });
  });

  describe('a machine outside this desktop’s protocol range', () => {
    const incompatible = { status: 'incompatible', link: 'incompatible' } as const;
    /** Past the status read at startup, whose client is gone by now. */
    const outOfRange = async () => {
      const r = await rig(incompatible);
      expect(r.sides.map((s) => s.status)).toEqual(['closed']);
      r.sides.length = 0;
      r.machines.openForUpdate.mockClear();
      return r;
    };

    it('updates an incompatible machine through an update-only client', async () => {
      const r = await outOfRange();
      expect(state.canStart(r.m as never)).toBe(true);

      await expect(state.prepare(ID)).resolves.toBeNull();

      expect(r.machines.openForUpdate).toHaveBeenCalledWith(ID);
      expect(r.client.request).not.toHaveBeenCalled();
      expect(r.starts).toEqual([{ version: LATEST, force: false }]);
      expect(state.stage(ID)).toBe('downloading');
      expect(r.sides).toHaveLength(1);
      const side = r.sides[0]!;
      expect(side.close).not.toHaveBeenCalled();

      // Its events are followed like the entry's.
      r.service.status = running('installing');
      side.emit('update.progress', running('installing'));
      expect(state.stage(ID)).toBe('installing');

      r.service.status = done;
      r.m.version = LATEST;
      side.emit('update.progress', done);
      expect(state.stage(ID)).toBeNull();
      expect(state.outcome(ID)).toEqual(done);
      expect(side.close).toHaveBeenCalled();
    });

    it('a busy machine closes the update-only client until the owner says', async () => {
      const r = await outOfRange();
      r.service.start = { started: false, busy: 1 };

      await expect(state.prepare(ID)).resolves.toEqual({ busy: 1 });
      expect(r.sides[0]!.close).toHaveBeenCalled();

      r.service.start = { started: true };
      await state.update(ID);
      expect(r.starts.at(-1)).toEqual({ version: LATEST, force: true });
      expect(r.sides).toHaveLength(2);
      expect(r.sides[1]!.close).not.toHaveBeenCalled();
    });

    it('a connection that fails is a failure, with nothing left open', async () => {
      const r = await outOfRange();
      r.reach.side = false;

      await expect(state.prepare(ID)).resolves.toBeNull();

      expect(state.stage(ID)).toBeNull();
      expect(state.outcome(ID)).toMatchObject({
        state: 'failed',
        reason: 'start',
        detail: 'Connection closed',
      });
    });

    it('a refused start closes the update-only client', async () => {
      const r = await outOfRange();
      r.service.start = new RequestError(UPDATE_ERRORS.NOT_SUPPORTED, 'No');
      await state.prepare(ID);
      expect(r.sides[0]!.close).toHaveBeenCalled();
      expect(state.outcome(ID)).toMatchObject({ state: 'failed', detail: 'No' });
    });

    it('its restart closes the client: a new one reads the end, and the entry reconnects', async () => {
      const r = await outOfRange();
      await state.prepare(ID);
      const first = r.sides[0]!;
      r.service.status = running('restarting');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.stage(ID)).toBe('restarting');

      r.reach.side = false;
      first.link('closed');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.stage(ID)).toBe('restarting');

      r.reach.side = true;
      r.service.status = done;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(r.sides).toHaveLength(2);
      expect(r.sides[1]!.close).toHaveBeenCalled();
      expect(r.machines.reconnect).toHaveBeenCalledWith(ID);

      // The entry learns the new version from the hello of that reconnect.
      expect(state.outcome(ID)).toBeNull();
      r.m.version = LATEST;
      expect(state.outcome(ID)).toEqual(done);
    });

    it('polling keeps one client while it stays open', async () => {
      const r = await outOfRange();
      await state.prepare(ID);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(r.sides).toHaveLength(1);
      expect(r.machines.openForUpdate).toHaveBeenCalledTimes(1);
    });

    it('a machine that never comes back fails after the limit too', async () => {
      const r = await outOfRange();
      await state.prepare(ID);
      r.service.status = running('restarting');
      await vi.advanceTimersByTimeAsync(2_000);
      r.reach.side = false;
      r.sides[0]!.link('closed');
      await vi.advanceTimersByTimeAsync(RECONNECT_WAIT_MS + 90_000);
      expect(state.stage(ID)).toBeNull();
      expect(state.outcome(ID)).toMatchObject({ state: 'failed', reason: 'start' });
    });

    it('a failed update leaves the entry as it is', async () => {
      const r = await outOfRange();
      await state.prepare(ID);
      r.service.status = failed;
      r.sides[0]!.emit('update.progress', failed);
      expect(state.outcome(ID)).toEqual(failed);
      expect(r.machines.reconnect).not.toHaveBeenCalled();
    });

    it('a machine that comes back outside the range is read through an update-only client', async () => {
      const r = await started('restarting');
      r.m.status = 'incompatible';
      r.client.link('incompatible');
      r.service.status = done;
      r.m.version = LATEST;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(state.outcome(ID)).toEqual(done);
      expect(r.sides).toHaveLength(1);
      expect(r.sides[0]!.close).toHaveBeenCalled();
      expect(state.behind(r.m)).toBe(false);
    });

    it('an Off machine that comes up outside the range is updated through one', async () => {
      const r = await rig({ status: 'unreachable', shown: 'off' });
      const pressed = state.prepare(ID);
      await flush();
      r.m.status = 'incompatible';
      r.m.shownAs = null;
      r.client.link('incompatible');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pressed).resolves.toBeNull();
      expect(r.sides).toHaveLength(1);
      expect(r.starts).toEqual([{ version: LATEST, force: false }]);
      expect(state.stage(ID)).toBe('downloading');
    });

    it('restores the outcome through a client it closes at once, without reconnecting', async () => {
      const r = await rig({ ...incompatible, service: done, version: LATEST });

      expect(state.outcome(ID)).toEqual(done);
      expect(r.sides).toHaveLength(1);
      expect(r.sides[0]!.close).toHaveBeenCalled();
      expect(r.machines.reconnect).not.toHaveBeenCalled();
    });

    it('reads again when the entry turns incompatible', async () => {
      const r = await rig({ status: 'unreachable' });
      r.service.status = failed;
      r.m.status = 'incompatible';
      r.client.link('incompatible');
      await flush();
      expect(state.outcome(ID)).toEqual(failed);
    });

    it('a restored running update keeps its own client', async () => {
      const r = await rig({ ...incompatible, service: running('installing') });
      expect(state.stage(ID)).toBe('installing');

      await vi.advanceTimersByTimeAsync(2_000);
      const open = r.sides.filter((s) => s.status === 'open');
      expect(open).toHaveLength(1);

      r.service.status = done;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(r.sides.every((s) => s.status === 'closed')).toBe(true);
    });

    it('dispose closes it', async () => {
      const r = await outOfRange();
      await state.prepare(ID);
      state.dispose();
      expect(r.sides[0]!.close).toHaveBeenCalled();
    });
  });
});

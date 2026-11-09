import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import {
  PROTOCOL_VERSION,
  type ChatItem,
  type EventMsg,
  type PowerConfig,
} from '@threadgarden/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { connectToMachine } from '../../src/away/deliverer.js';
import { pairWithMachine } from '../../src/machine/pairing-client.js';
import { createSwitch } from '../../src/power/switch.js';
import {
  MOCK_FORGET_MOVES,
  PHONE_NAME,
  REMOTE_MACHINE_NAME,
  refusedByThePhone,
  REMOTE_PROJECT_PATH,
  startMockService,
  type MockService,
} from '../../src/testing/mock-main.js';
import { TestClient, chatStatus, eventually } from '../e2e/ws-client.js';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });

const itemsOf = (events: EventMsg[], sessionId: string): ChatItem[] => {
  const map = new Map<string, ChatItem>();
  for (const e of events) {
    const d = e.data as { sessionId?: string; items?: ChatItem[] };
    if (e.event === 'chat.items' && d.sessionId === sessionId)
      for (const i of d.items ?? []) map.set(i.id, i);
  }
  return [...map.values()];
};

const HELLO = { protocolVersion: PROTOCOL_VERSION, client: 'test' };

let mock: MockService | undefined;
let client: TestClient | undefined;
afterEach(async () => {
  await client?.close();
  if (mock) {
    await mock.svc.close();
    await mock.removed;
  }
  mock = undefined;
  client = undefined;
});

describe('mock service', () => {
  it('serves the corpus on a fixed port and token and follows the script', async () => {
    const port = await freePort();
    mock = await startMockService({
      sessions: 20,
      projects: 3,
      bigSessionMessages: 10,
      port,
      token: 'mock-token',
      installSignalHandlers: false,
    });
    expect(mock.svc.port).toBe(port);
    const c = (client = await TestClient.connect(port, 'mock-token'));
    await eventually(async () => (await c.call<{ all: number }>('places.counts', {})).all === 21);

    // The corpus's folders (/work/proj-N) are not on disk, yet no project counts as missing.
    await c.call('projects.list', {});
    await new Promise((r) => setTimeout(r, 300));
    const projects = await c.call<{ exists: boolean }[]>('projects.list', {});
    expect(projects).toHaveLength(3);
    expect(projects.every((p) => p.exists)).toBe(true);

    // v1.3: some mock projects have an icon (found by the real search in fixtures), others not.
    const iconOf = async (n: number) => {
      const id = (projects as unknown as { projectId: string; displayName: string }[]).find(
        (p) => p.displayName === `proj-${n}`,
      )!.projectId;
      return (await c.call<{ dataUrl: string | null }>('projects.icon', { projectId: id })).dataUrl;
    };
    expect(await iconOf(0)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await iconOf(1)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await iconOf(2)).toMatch(/^data:image\/svg\+xml;base64,/);

    // Plain reply: streamed text, then idle.
    const plain = await c.call<{ sessionId: string }>('chat.create', { cwd: '/work', text: 'hi' });
    await c.waitFor(chatStatus(plain.sessionId, 'idle'), 10_000);
    const reply = itemsOf(c.events, plain.sessionId).find((i) => i.kind === 'assistantText');
    expect(reply).toMatchObject({ streaming: false });
    expect((reply as { markdown: string }).markdown).toMatch(/Threadgarden mock service/);
    const header = await c.call<{ header: { auth?: { kind: string } } }>('chat.open', {
      sessionId: plain.sessionId,
      tail: 10,
    });
    expect(header.header.auth?.kind).toBe('subscription');
    // v1.2 C1: named from its first message at once, then by the fake small model.
    const titleOf = async (id: string) =>
      (await c.call<{ items: { title: string }[] }>('sessions.summaries', { sessionIds: [id] }))
        .items[0]?.title;
    await eventually(async () => (await titleOf(plain.sessionId)) === 'Mock: hi', 5_000);

    // "perm" → Bash permission request → allowed → tool call runs.
    const perm = await c.call<{ sessionId: string }>('chat.create', {
      cwd: '/work',
      text: 'check perm please',
    });
    await c.waitFor(chatStatus(perm.sessionId, 'needsYou'), 10_000);
    const req = itemsOf(c.events, perm.sessionId).find((i) => i.kind === 'permissionRequest') as {
      requestId: string;
      toolName: string;
    };
    expect(req.toolName).toBe('Bash');
    await c.call('chat.respond', {
      sessionId: perm.sessionId,
      requestId: req.requestId,
      decision: 'allow',
    });
    await c.waitFor(chatStatus(perm.sessionId, 'idle'), 10_000);
    expect(itemsOf(c.events, perm.sessionId).find((i) => i.kind === 'toolCall')).toMatchObject({
      name: 'Bash',
      status: 'ok',
    });

    // "ask" → AskUserQuestion; "plan" → ExitPlanMode.
    for (const [text, toolName, variant] of [
      ['ask me', 'AskUserQuestion', 'question'],
      ['make a plan', 'ExitPlanMode', 'plan'],
    ] as const) {
      const s = await c.call<{ sessionId: string }>('chat.create', { cwd: '/work', text });
      await c.waitFor(chatStatus(s.sessionId, 'needsYou'), 10_000);
      expect(
        itemsOf(c.events, s.sessionId).find((i) => i.kind === 'permissionRequest'),
      ).toMatchObject({ toolName, variant });
    }

    expect((await c.call<unknown[]>('chat.commands', { sessionId: plain.sessionId })).length).toBe(
      3,
    );
  }, 30_000);
  it('"agent" runs a subagent task to completion; "server" keeps a shell task until stopped', async () => {
    mock = await startMockService({
      sessions: 2,
      projects: 1,
      bigSessionMessages: 4,
      port: await freePort(),
      token: 'mock-token',
      installSignalHandlers: false,
    });
    const c = (client = await TestClient.connect(mock.svc.port, 'mock-token'));
    type Task = {
      taskId: string;
      kind: string;
      status: string;
      description: string;
      model?: string;
    };
    const tasksOf = (sessionId: string): Task[] | undefined =>
      c.events
        .filter(
          (e) =>
            e.event === 'chat.tasks' && (e.data as { sessionId: string }).sessionId === sessionId,
        )
        .map((e) => (e.data as { tasks: Task[] }).tasks)
        .at(-1);

    // "agent": a subagent that progresses, then completes about 3 s later.
    const agent = await c.call<{ sessionId: string }>('chat.create', {
      cwd: '/work',
      text: 'use an agent to explore',
    });
    await eventually(() => tasksOf(agent.sessionId)?.[0]?.status === 'running', 5_000);
    expect(tasksOf(agent.sessionId)?.[0]).toMatchObject({
      kind: 'agent',
      subagentType: 'Explore',
      toolUseId: expect.any(String),
      model: 'haiku',
      prompt: expect.any(String),
    });
    await eventually(
      () => (tasksOf(agent.sessionId)?.[0] as { tokens?: number } | undefined)?.tokens,
      5_000,
    );
    // Its nested subagent, whose model only its streamed messages tell.
    await eventually(() => tasksOf(agent.sessionId)?.[1]?.model === 'claude-sonnet-4-5', 5_000);
    expect(tasksOf(agent.sessionId)?.[1]).toMatchObject({
      parentTaskId: tasksOf(agent.sessionId)?.[0]?.taskId,
      spawnDepth: 2,
    });
    await eventually(() => tasksOf(agent.sessionId)?.[0]?.status === 'completed', 8_000);
    expect(tasksOf(agent.sessionId)?.[1]?.status).toBe('completed');
    await c.waitFor(chatStatus(agent.sessionId, 'idle'), 5_000);
    const calls = itemsOf(c.events, agent.sessionId).filter((i) => i.kind === 'toolCall');
    expect(calls).toEqual([
      expect.objectContaining({ name: 'Agent', status: 'ok' }),
      expect.objectContaining({ name: 'Agent', status: 'ok', parentToolUseId: expect.any(String) }),
      expect.objectContaining({ name: 'Grep', status: 'ok', parentToolUseId: expect.any(String) }),
    ]);

    // "server": a background shell that keeps running after the turn ends.
    const server = await c.call<{ sessionId: string }>('chat.create', {
      cwd: '/work',
      text: 'start the dev server',
    });
    await c.waitFor(chatStatus(server.sessionId, 'idle'), 10_000);
    const opened = await c.call<{ tasks: Task[] }>('chat.open', {
      sessionId: server.sessionId,
      tail: 20,
    });
    expect(opened.tasks).toEqual([
      expect.objectContaining({
        kind: 'shell',
        description: 'npm run dev',
        status: 'running',
        backgrounded: true,
      }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(tasksOf(server.sessionId)?.[0]?.status).toBe('running');
    await c.call('chat.stopTask', { sessionId: server.sessionId, taskId: opened.tasks[0]!.taskId });
    await eventually(() => tasksOf(server.sessionId)?.[0]?.status === 'stopped', 5_000);
  }, 30_000);

  it('v1.3 B: shows usage from the start; "limit" refuses turns until the reset', async () => {
    mock = await startMockService({
      sessions: 2,
      projects: 1,
      bigSessionMessages: 4,
      port: await freePort(),
      token: 'mock-token',
      installSignalHandlers: false,
    });
    const c = (client = await TestClient.connect(mock.svc.port, 'mock-token'));
    type Usage = {
      windows: { key: string; utilization?: number; status?: string; source: string }[];
      refused: { sessionId: string; resetsAt?: number }[];
      subscriptionType?: string;
    };
    const first = await c.call<Usage>('usage.get', {});
    expect(first.windows.map((w) => [w.key, Math.round(w.utilization ?? 0)])).toEqual([
      ['five_hour', 42],
      ['seven_day', 23],
    ]);

    const s = await c.call<{ sessionId: string }>('chat.create', {
      cwd: '/work',
      text: 'use up the limit',
    });
    await c.waitFor(chatStatus(s.sessionId, 'idle'), 10_000);
    const limited = await c.call<Usage>('usage.get', {});
    expect(limited.windows.find((w) => w.key === 'five_hour')).toMatchObject({
      status: 'rejected',
      utilization: 100,
    });
    expect(limited.refused).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, resetsAt: expect.any(Number) }),
    ]);
    const reply = itemsOf(c.events, s.sessionId).find((i) => i.kind === 'assistantText');
    expect((reply as { markdown: string }).markdown).toMatch(/usage limit/);

    // The reading of a running session adds the weekly and per-model windows.
    const read = await c.call<Usage>('usage.get', { refresh: true });
    expect(read.subscriptionType).toBe('max');
    expect(read.windows.map((w) => w.key)).toEqual(
      expect.arrayContaining(['five_hour', 'seven_day', 'seven_day_opus', 'model:Fable']),
    );
    const scheduled = await c.call<{ sendAt: number }>('scheduled.create', {
      sessionId: s.sessionId,
      text: 'carry on',
      whenLimitResets: true,
    });
    expect(scheduled.sendAt).toBeGreaterThan(Date.now());
  }, 30_000);
});

describe('mock service --remote (v1.4)', () => {
  it('is a headless "Ubuntu" with tg-cli on 127.0.0.1 that keeps its fixed code live', async () => {
    mock = await startMockService({
      remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
      installSignalHandlers: false,
    });
    expect(mock.svc.remote?.addresses).toEqual(['127.0.0.1']);
    const remotePort = mock.svc.remote!.port;
    const c = (client = await TestClient.connect(mock.svc.port, mock.svc.token));
    await eventually(async () => (await c.call<{ all: number }>('places.counts', {})).all === 20);
    const projects = await c.call<{ displayName: string; path: string }[]>('projects.list', {});
    // (Paths are in this OS's form: backslashes on Windows.)
    expect(projects.map((p) => [p.displayName, p.path.replace(/\\/g, '/')])).toEqual([
      ['tg-cli', REMOTE_PROJECT_PATH],
    ]);

    // Paired with the fixed code (typed any way); the spent code is live again soon after.
    const pairAs = (deviceName: string) =>
      pairWithMachine({
        address: '127.0.0.1',
        port: remotePort,
        code: 'test-test-test',
        deviceName,
      });
    const first = await pairAs('Desk');
    expect(first.machine).toMatchObject({ name: REMOTE_MACHINE_NAME, headless: true });
    await eventually(
      () =>
        pairAs('Laptop').then(
          () => true,
          () => new Promise<false>((r) => setTimeout(() => r(false), 200)),
        ),
      5_000,
    );
    const devices = await c.call<{ name: string }[]>('devices.list', {});
    expect(devices.map((d) => d.name)).toEqual(['Desk', 'Laptop']);
  }, 30_000);

  it('fails when its device port is taken', async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const { port } = taken.address() as { port: number };
    try {
      await expect(
        startMockService({
          remote: { port, pairingCode: 'TEST-TEST-TEST' },
          installSignalHandlers: false,
        }),
      ).rejects.toThrow(/device listener did not start/);
    } finally {
      await new Promise((r) => taken.close(r));
    }
  });

  it('refuses a pairing code that cannot be one', async () => {
    await expect(
      startMockService({
        remote: { port: 0, pairingCode: 'TEST-TEST' },
        installSignalHandlers: false,
      }),
    ).rejects.toThrow(/Invalid pairing code/);
  });
});

describe('mock service: updating a machine (protocol 10)', () => {
  type Progress = {
    state: string;
    version?: string;
    from?: string;
    stage?: string;
    reason?: string;
  };
  const progress = (c: TestClient): Progress[] =>
    c.events.filter((e) => e.event === 'update.progress').map((e) => e.data as Progress);
  const start = async () => {
    mock = await startMockService({
      remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
      sessions: 3,
      installSignalHandlers: false,
    });
    return (client = await TestClient.connect(mock.svc.port, mock.svc.token));
  };
  const deviceSocket = async (token: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://127.0.0.1:${mock!.svc.remote!.port}`,
        [`threadgarden-device.${token}`],
        {
          rejectUnauthorized: false,
        },
      );
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  const helloOf = (ws: WebSocket): Promise<{ serviceVersion: string }> =>
    new Promise((resolve) => {
      const onMessage = (d: unknown) => {
        const m = JSON.parse(String(d)) as { id?: number; result?: { serviceVersion: string } };
        if (m.id !== 1) return;
        ws.off('message', onMessage);
        resolve(m.result!);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ id: 1, method: 'hello', params: HELLO }));
    });

  it('the remote mock updates to 0.99.0 and reports it in hello after the pretend restart', async () => {
    const c = await start();
    expect(
      (await c.call<{ machine: { capabilities: string[] } }>('hello', HELLO)).machine.capabilities,
    ).toContain('update');
    const paired = await pairWithMachine({
      address: '127.0.0.1',
      port: mock!.svc.remote!.port,
      code: 'TEST-TEST-TEST',
      deviceName: 'Desk',
    });
    const device = await deviceSocket(paired.token);
    const before = (await helloOf(device)).serviceVersion;
    expect(before).not.toBe('0.99.0');
    const dropped = new Promise<void>((r) => device.once('close', () => r()));

    expect(await c.call('update.latest', {})).toEqual({ version: '0.99.0' });
    expect(await c.call('update.start', { version: '0.99.0', force: false })).toEqual({
      started: true,
    });
    await dropped;
    await eventually(
      async () => (await c.call<{ state: string }>('update.status', {})).state === 'done',
    );

    expect(progress(c).map((p) => p.stage ?? p.state)).toEqual([
      'downloading',
      'installing',
      'restarting',
      'done',
    ]);
    expect(await c.call('update.status', {})).toMatchObject({
      state: 'done',
      version: '0.99.0',
      from: before,
    });
    const again = await deviceSocket(paired.token);
    expect((await helloOf(again)).serviceVersion).toBe('0.99.0');
    again.close();
  }, 30_000);

  it('failNextUpdate(checksum) makes the next update fail with checksum', async () => {
    const c = await start();
    await c.call('mock.failNextUpdate', { reason: 'checksum' });
    await c.call('update.start', { version: '0.99.0', force: true });
    await eventually(
      async () => (await c.call<{ state: string }>('update.status', {})).state === 'failed',
    );
    expect(progress(c).at(-1)).toMatchObject({
      state: 'failed',
      version: '0.99.0',
      reason: 'checksum',
    });
    expect(await c.call('update.status', {})).toMatchObject({
      state: 'failed',
      reason: 'checksum',
    });
    // The version didn't change, and the failure was for that one update only.
    expect((await c.call<{ serviceVersion: string }>('hello', HELLO)).serviceVersion).not.toBe(
      '0.99.0',
    );
    await c.call('update.start', { version: '0.99.0', force: true });
    await eventually(
      async () => (await c.call<{ state: string }>('update.status', {})).state === 'done',
    );
  }, 30_000);

  it('a busy machine is not updated without force, and a second start is refused while running', async () => {
    const c = await start();
    await c.call('mock.setBusy', { count: 2 });
    expect(await c.call('update.start', { version: '0.99.0', force: false })).toEqual({
      started: false,
      busy: 2,
    });
    expect(await c.call('update.status', {})).toEqual({ state: 'idle' });
    expect(await c.call('update.start', { version: '0.99.0', force: true })).toEqual({
      started: true,
    });
    await expect(c.call('update.start', { version: '0.99.0', force: true })).rejects.toMatchObject({
      code: 'UPDATE_RUNNING',
    });
  }, 30_000);

  it('the main mock answers update.latest from THREADGARDEN_MOCK_LATEST', async () => {
    mock = await startMockService({ sessions: 3, installSignalHandlers: false });
    const c = (client = await TestClient.connect(mock.svc.port, mock.svc.token));
    expect(await c.call('update.latest', {})).toEqual({ version: '0.99.0' });
  });
});

describe('mock service --fake-tasmota', () => {
  it('a shutdown reaches the mock power-off, never systemctl', async () => {
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      mock = await startMockService({
        remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
        fakeTasmota: { port: 0 },
        sessions: 3,
        port: await freePort(),
        token: 'mock-token',
        installSignalHandlers: false,
      });
      const c = (client = await TestClient.connect(mock.svc.port, 'mock-token'));
      await c.call('power.adopt', {
        config: {
          kind: 'tasmota-zigbee',
          address: mock.fakeTasmota!.address,
          device: 'MockPlug',
          offWatts: 5,
          minOffSeconds: 90,
          measured: { running: null, standby: null },
        },
        password: 'mock-switch',
      });
      await c.call('power.shutdown', { force: true });
      await eventually(async () => written.some((w) => w.includes('mock: would power off')));
    } finally {
      process.stderr.write = write;
    }
  });
});

describe('mock service: a machine that is away', () => {
  const PLUG: PowerConfig = {
    kind: 'tasmota-zigbee',
    address: '',
    device: 'MockPlug',
    offWatts: 5,
    minOffSeconds: 90,
    measured: { running: null, standby: null },
  };
  /** The remote mock with its plug, paired with a device; a link as the deliverer opens one. */
  const start = async () => {
    mock = await startMockService({
      remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
      fakeTasmota: { port: 0 },
      sessions: 3,
      installSignalHandlers: false,
    });
    const c = (client = await TestClient.connect(mock.svc.port, mock.svc.token));
    const paired = await pairWithMachine({
      address: '127.0.0.1',
      port: mock.svc.remote!.port,
      code: 'TEST-TEST-TEST',
      deviceName: 'Desk',
    });
    const machine = {
      id: paired.machine.id,
      name: paired.machine.name,
      address: '127.0.0.1',
      port: mock.svc.remote!.port,
      certPem: paired.certPem,
      fingerprint: paired.fingerprint,
      deviceId: paired.deviceId,
      addedAt: 0,
      unlocked: true,
    };
    const connect = connectToMachine(
      { get: () => machine, token: () => paired.token },
      { linkTimeoutMs: 2_000 },
    );
    const plug = createSwitch({ ...PLUG, address: mock.fakeTasmota!.address }, 'mock-switch', {
      readWaitMs: 0,
    });
    return { c, connect: () => connect(machine.id), plug };
  };

  it('goAway drops the devices and answers none, its plug reads Off; switched on, it is back about 2 s later', async () => {
    const { c, connect, plug } = await start();
    const link = await connect();
    expect(await link!.request('hello', HELLO)).toMatchObject({ machine: { name: 'Ubuntu' } });
    expect(await plug.reading()).toMatchObject({ on: true, watts: 47 });

    await c.call('mock.goAway', {});
    // Its link is cut.
    await expect(link!.request('hello', HELLO)).rejects.toThrow();
    // Not reachable, as a PC without power: never a refusal, which would mean "pair again".
    expect(await connect()).toBeNull();
    expect(await plug.reading()).toMatchObject({ on: false, watts: 0 });

    await plug.setPower(true);
    const on = Date.now();
    expect(await connect()).toBeNull();
    const back = (await eventually(connect, 10_000))!;
    expect(Date.now() - on).toBeGreaterThanOrEqual(1_500);
    expect(await back.request('hello', HELLO)).toMatchObject({ machine: { name: 'Ubuntu' } });
    back.close();
  }, 30_000);

  it('comeBack lets the devices in again at once, with the plug on', async () => {
    const { c, connect, plug } = await start();
    await c.call('mock.goAway', {});
    expect(await connect()).toBeNull();
    await c.call('mock.comeBack', {});
    const link = await connect();
    expect(link).not.toBeNull();
    link!.close();
    expect(await plug.reading()).toMatchObject({ on: true, watts: 47 });
  }, 30_000);

  it('only the remote mock has them, for its own callers only', async () => {
    const { c } = await start();
    const asDevice = await mock!.svc.router.dispatch(
      { id: 1, method: 'mock.goAway', params: {} },
      { clientId: 't', origin: 'remote', deviceId: 'd' },
    );
    expect(asDevice).toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
    await c.close();
    client = undefined;
    await mock!.svc.close();
    await mock!.removed;
    mock = await startMockService({ sessions: 3, installSignalHandlers: false });
    const main = (client = await TestClient.connect(mock.svc.port, mock.svc.token));
    await expect(main.call('mock.goAway', {})).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  }, 30_000);
});

describe('mock service: moving a chat (protocol 9)', () => {
  const started: MockService[] = [];
  afterEach(async () => {
    for (const m of started.splice(0)) {
      await m.svc.close();
      await m.removed;
    }
  });

  const ok = async <T = unknown>(m: MockService, method: string, params: unknown): Promise<T> => {
    const r = await m.svc.router.dispatch(
      { id: 1, method, params },
      { clientId: 't', origin: 'local' },
    );
    if ('error' in r) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
    return r.result as T;
  };
  const active = async (m: MockService) => (await ok<{ all: number }>(m, 'places.counts', {})).all;

  type Key = { subpath?: string; entries: { type: string; message?: { content?: unknown } }[] };
  /** A chat's export from `m`, every key of every part (then let go of). */
  const exported = async (m: MockService, sessionId: string, exportId: string): Promise<Key[]> => {
    const begun = await ok<{ parts: number }>(m, 'move.exportBegin', { sessionId, exportId });
    const keys: Key[] = [];
    for (let index = 0; index < begun.parts; index++) {
      keys.push(...(await ok<{ keys: Key[] }>(m, 'move.exportPart', { exportId, index })).keys);
    }
    return keys;
  };

  it('fakes clean git, moves a chat to the remote mock and keeps its first note’s plain reply in the store', async () => {
    const here = await startMockService({
      sessions: 30,
      projects: 3,
      bigSessionMessages: 4,
      port: await freePort(),
      token: 'mock-token',
      installSignalHandlers: false,
    });
    started.push(here);
    const there = await startMockService({
      remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
      installSignalHandlers: false,
    });
    started.push(there);
    await eventually(async () => (await active(here)) === 31);
    await eventually(async () => (await active(there)) === 20);

    // No real git runs on the mocks' folders (not on disk): each project is a clean clone on main.
    const id = 'session-25';
    expect(await ok(here, 'move.check', { sessionId: id })).toEqual({
      cwd: '/work/proj-1',
      busy: null,
      git: { kind: 'clean', branch: 'main', origin: 'https://github.com/owner/proj-1.git' },
    });
    expect(await ok(there, 'move.check', { sessionId: 'session-3' })).toMatchObject({
      git: { kind: 'clean', branch: 'main', origin: 'https://github.com/owner/tg-cli.git' },
    });

    // On the remote, a chat of that repo goes where New project would put it: in the mock's temp dir.
    const target = await ok<{ folder: string }>(there, 'move.target', {
      origin: 'https://github.com/owner/proj-1.git',
      repoName: 'proj-1',
      branch: 'main',
    });
    const createIn = join(dirname(there.dataDir), 'projects');
    expect(target).toEqual({ folder: join(createIn, 'proj-1'), matched: true, inUse: null });

    // The transfer, as the desktop drives it.
    const keys = await exported(here, id, 'export-1');
    await ok(there, 'move.importPart', {
      importId: 'i-1',
      sessionId: id,
      index: 0,
      parts: 1,
      keys,
    });
    await ok(there, 'move.commit', {
      importId: 'i-1',
      sessionId: id,
      cwd: target.folder,
      from: { machineId: 'this-pc', name: 'This PC' },
    });
    await ok(here, 'move.markMoved', {
      exportId: 'export-1',
      sessionId: id,
      begunAt: Date.now(),
      to: { machineId: 'ubuntu', name: REMOTE_MACHINE_NAME },
    });
    // The mock makes no folder for it.
    expect(existsSync(target.folder)).toBe(false);
    expect(await active(here)).toBe(30);
    await eventually(async () => (await active(there)) === 21);

    // The first note says "ask", yet gets the plain reply: no question blocks a move back.
    await ok(there, 'chat.send', {
      sessionId: id,
      text: '[Threadgarden] This chat moved from This PC to Ubuntu.\n\nIf so, stop and ask the owner.',
    });
    const reply = 'This is the Threadgarden mock service answering.';
    type Items = { items: { kind: string; markdown?: string; streaming?: boolean }[] };
    const items = await eventually(async () => {
      const { items } = await ok<Items>(there, 'chat.open', { sessionId: id, tail: 50 });
      const last = items.filter((i) => i.kind === 'assistantText').at(-1);
      const done = !!last?.markdown?.includes(reply) && !last.streaming;
      const idle = async () =>
        (await ok<{ busy: unknown }>(there, 'move.check', { sessionId: id })).busy === null;
      return done && (await idle()) ? items : null;
    }, 10_000);
    expect(items!.some((i) => i.kind === 'permissionRequest')).toBe(false);
    expect(items!.filter((i) => i.kind === 'assistantText').at(-1)?.markdown).toContain(reply);

    // Like the SDK, a store-backed turn is recorded in the store only: the move back carries it.
    expect(there.adapter.sessions.has(id)).toBe(false);
    const back = await exported(there, id, 'export-2');
    const said = (back[0]?.entries ?? []).map((e) => JSON.stringify(e.message?.content ?? ''));
    expect(said.some((s) => s.includes('[Threadgarden] This chat moved'))).toBe(true);
    expect(said.some((s) => s.includes(reply))).toBe(true);
    await ok(there, 'move.abort', { exportId: 'export-2' });

    // The mock's test reset: the chat is This PC's own again, and the remote lets go of its copy.
    expect(await ok(here, MOCK_FORGET_MOVES, {})).toEqual({});
    expect(await active(here)).toBe(31);
    expect(await ok(here, 'chat.open', { sessionId: id, tail: 1 })).toMatchObject({
      movedTo: null,
    });
    await ok(there, MOCK_FORGET_MOVES, {});
    await eventually(async () => (await active(there)) === 20);
    // A paired device can't call it.
    const remote = await there.svc.router.dispatch(
      { id: 2, method: MOCK_FORGET_MOVES, params: {} },
      { clientId: 't', origin: 'remote', deviceId: 'd' },
    );
    expect(remote).toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
  }, 30_000);
});

describe('mock service MOCK_PHONE (phone plan, Task 11)', () => {
  it("answers like the phone's core, with the remote mock paired", async () => {
    const remoteMock = await startMockService({
      remote: { port: 0, pairingCode: 'TEST-TEST-TEST' },
      installSignalHandlers: false,
    });
    try {
      mock = await startMockService({
        phone: { pairWith: { port: remoteMock.svc.remote!.port, pairingCode: 'TEST-TEST-TEST' } },
        installSignalHandlers: false,
      });
      const c = (client = await TestClient.connect(mock.svc.port, mock.svc.token));
      // As the core says: an empty machine that isn't headless and can do nothing itself.
      const hello = await c.call<{ machine: Record<string, unknown> }>('hello', HELLO);
      expect(hello.machine).toEqual({
        id: expect.any(String),
        name: PHONE_NAME,
        platform: 'linux',
        headless: false,
        home: '',
        capabilities: [],
      });
      // Nothing of its own: no chats, no projects, no usage, no Claude Code.
      expect(await c.call('projects.list', {})).toEqual([]);
      expect(
        await c.call<{ items: unknown[] }>('sessions.list', {
          place: { kind: 'active' },
          limit: 50,
        }),
      ).toMatchObject({ items: [] });
      expect(await c.call('places.counts', {})).toMatchObject({ needsYou: 0, running: 0, all: 0 });
      expect(await c.call<{ windows: unknown[] }>('usage.get', {})).toMatchObject({ windows: [] });
      expect(await c.call('system.status', {})).toMatchObject({ claude: { found: false } });

      // What the core refuses, the mock refuses (the core's contract table): chats and
      // projects of This PC, analytics, its updater, and pairing until the core can.
      for (const method of ['chat.create', 'projects.create', 'analytics.get', 'update.latest']) {
        await expect(c.call(method, {}), method).rejects.toMatchObject({
          code: 'METHOD_NOT_FOUND',
        });
      }
      await expect(
        c.call('machines.pair', { address: '127.0.0.1', code: 'TEST-TEST-TEST', deviceName: 'X' }),
      ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
      expect(refusedByThePhone()).toContain('chat.send');
      expect(refusedByThePhone()).not.toContain('machines.list');

      // The remote mock, paired and unlocked by the mock itself (the core holds the token).
      await mock.paired;
      const list = await c.call<{ name: string; unlocked: boolean }[]>('machines.list', {});
      expect(list).toEqual([
        expect.objectContaining({ name: REMOTE_MACHINE_NAME, unlocked: true }),
      ]);
      const r = await TestClient.connect(remoteMock.svc.port, remoteMock.svc.token);
      try {
        const devices = await r.call<{ name: string }[]>('devices.list', {});
        expect(devices.map((d) => d.name)).toEqual([PHONE_NAME]);
      } finally {
        await r.close();
      }
    } finally {
      await remoteMock.svc.close();
      await remoteMock.removed;
    }
  }, 30_000);
});

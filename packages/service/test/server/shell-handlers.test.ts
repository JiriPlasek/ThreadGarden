/** shell.* against the real service wiring, a fake adapter and a fake PTY. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type ShellRun, type ShellView } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/logger.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { Router } from '../../src/server/router.js';
import { registerShellHandlers } from '../../src/server/handlers/shell.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { fakePtyFactory } from '../../src/testing/fake-pty.js';
import { eventually, TestClient } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;
const logged: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-shell-'));
  logged.length = 0;
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const addHistory = (adapter: FakeAdapter, sessionId: string, cwd = dir) => {
  const messages = [
    {
      type: 'user',
      uuid: `${sessionId}-u`,
      session_id: sessionId,
      message: { role: 'user', content: 'hi' },
    },
    {
      type: 'assistant',
      uuid: `${sessionId}-a`,
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    },
  ] as unknown as SessionMessage[];
  adapter.sessions.set(sessionId, {
    info: {
      sessionId,
      summary: `Chat ${sessionId}`,
      lastModified: 1_700_000_000_000,
      fileSize: 100,
      cwd,
    },
    messages,
  });
};

const logger: Logger = {
  debug: (m) => void logged.push(m),
  info: (m) => void logged.push(m),
  warn: (m) => void logged.push(m),
  error: (m) => void logged.push(m),
  flush: async () => {},
};

const start = async (adapter: FakeAdapter, over: Partial<StartOptions> = {}) => {
  const fake = fakePtyFactory();
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    logger,
    shell: { pty: fake.factory, line: (c) => ({ file: 'sh', args: ['-c', c] }) },
    ...over,
  });
  client = await TestClient.connect(svc.port, svc.token);
  await eventually(async () => {
    const r = await client!.call<{ all: number }>('places.counts', {});
    return r.all === adapter.sessions.size;
  });
  return { fake, client: client };
};

const run = (c: TestClient, sessionId: string, command = 'echo hi') =>
  c.call<ShellRun>('shell.start', { sessionId, command, cols: 80, rows: 24 });

const runs = (c: TestClient) =>
  c.events.filter((e) => e.event === 'shell.run').map((e) => e.data as ShellRun);

describe('shell.start', () => {
  it('start resumes a paused chat and runs the command in its folder', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    const { fake, client: c } = await start(adapter);
    const r = await run(c, 'h1', 'ls');
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]!.options.resume).toBe('h1');
    expect(fake.last().spawned.o.cwd).toBe(dir);
    expect(fake.last().spawned.args).toEqual(['-c', 'ls']);
    expect(r).toMatchObject({
      sessionId: 'h1',
      command: 'ls',
      cwd: dir,
      state: 'running',
      cols: 80,
    });
  });

  it('start honours a blocked resume check', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'held');
    const agents = JSON.stringify([
      { pid: 7, cwd: dir, kind: 'interactive', startedAt: 1, sessionId: 'held', status: 'busy' },
    ]);
    const { fake, client: c } = await start(adapter, { externalRun: async () => agents });
    const r = await c.raw('shell.start', { sessionId: 'held', command: 'ls', cols: 80, rows: 24 });
    expect(r.error?.code).toBe('RESUME_BLOCKED');
    expect(() => fake.last()).toThrow('nothing spawned');
    expect(adapter.started).toHaveLength(0);
  });

  it('start refuses a Codex chat, a moving chat and a moved chat', async () => {
    const adapter = new FakeAdapter();
    const { client: c } = await start(adapter);
    const codex = 'codex-12345678-1234-1234-1234-123456789abc';
    const r = await c.raw('shell.start', { sessionId: codex, command: 'ls', cols: 80, rows: 24 });
    expect(r.error).toMatchObject({
      code: 'SHELL_UNSUPPORTED',
      message: '! commands are for Claude chats',
    });

    const router = new Router({ error: () => {} });
    let resumed = 0;
    registerShellHandlers(router, {
      host: {} as never,
      resumedOrLive: async () => {
        resumed++;
        throw new Error('not reached');
      },
      activate: () => {},
      isMoving: (id) => id === 'moving',
      awayTo: (id) => (id === 'away' ? { name: 'Laptop' } : undefined),
    });
    const ctx = { clientId: 't', origin: 'local' as const };
    const call = (sessionId: string) =>
      router.dispatch(
        { id: 1, method: 'shell.start', params: { sessionId, command: 'ls', cols: 80, rows: 24 } },
        ctx,
      ) as Promise<{ error?: { code: string; message: string } }>;
    expect((await call('moving')).error).toMatchObject({ code: 'MOVING' });
    expect((await call('away')).error).toMatchObject({
      code: 'MOVED',
      message: 'This chat moved to Laptop',
    });
    expect(resumed).toBe(0);
  });
});

describe('a running command', () => {
  it('output and the end reach clients as events; the end is appended', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    const { fake, client: c } = await start(adapter);
    const r = await run(c, 'h1', 'echo hi');
    fake.last().emit('hi\r\n');
    const out = await c.waitFor((e) => e.event === 'shell.output');
    expect(out.data).toMatchObject({ runId: r.runId, data: 'hi\r\n' });
    fake.last().exit(0);
    await eventually(async () =>
      runs(c).some((x) => x.state === 'ended' && x.entryId !== undefined),
    );
    const texts = adapter.lastSession().sent.map((m) => JSON.stringify(m.message));
    expect(texts[0]).toContain('<bash-input>echo hi</bash-input>');
    expect(texts[1]).toContain('<bash-stdout>hi');
    expect(adapter.lastSession().sent.every((m) => m.shouldQuery === false)).toBe(true);
  });

  it('input, resize and stop go to the run; an unknown run is SHELL_NOT_RUNNING', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    const { fake, client: c } = await start(adapter);
    const r = await run(c, 'h1', 'cat');
    await c.call('shell.input', { runId: r.runId, data: 'abc' });
    await c.call('shell.resize', { runId: r.runId, cols: 120, rows: 30 });
    expect(fake.last().written).toContain('abc');
    expect(fake.last().resizes).toEqual([{ cols: 120, rows: 30 }]);
    await c.call('shell.stop', { runId: r.runId });
    expect(fake.last().written).toContain('\x03');
    for (const [method, params] of [
      ['shell.input', { runId: 'nope', data: 'x' }],
      ['shell.resize', { runId: 'nope', cols: 80, rows: 24 }],
      ['shell.stop', { runId: 'nope' }],
    ] as const) {
      expect((await c.raw(method, params)).error?.code, method).toBe('SHELL_NOT_RUNNING');
    }
  });

  it('never logs or echoes input', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    const { fake, client: c } = await start(adapter);
    const r = await run(c, 'h1', 'sudo true');
    await c.call('shell.input', { runId: r.runId, data: 'hunter2\r' });
    const unknown = await c.raw('shell.input', { runId: 'nope', data: 'hunter2' });
    expect(unknown.error?.code).toBe('SHELL_NOT_RUNNING');
    const tooLong = await c.raw('shell.input', {
      runId: r.runId,
      data: 'hunter2'.padEnd(70_000, 'x'),
    });
    expect(tooLong.error).toBeDefined();
    fake.last().exit(0);
    await eventually(async () => runs(c).some((x) => x.entryId !== undefined));
    const written = fake.last().written.join('');
    const sent = JSON.stringify(adapter.lastSession().sent);
    const events = JSON.stringify(c.events);
    await svc!.close();
    svc = undefined;
    const everything = [...logged, JSON.stringify(tooLong), events, sent];
    for (const part of everything) expect(part).not.toContain('hunter2');
    const data = join(dir, 'data');
    for (const f of await readdir(data)) {
      const body = await readFile(join(data, f)).catch(() => Buffer.alloc(0));
      expect(body.includes('hunter2'), f).toBe(false);
    }
    expect(written).toContain('hunter2');
  });

  it('get and chat.open return the run, its scrollback and offset; nothing for a chat without one', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    addHistory(adapter, 'h2');
    const { fake, client: c } = await start(adapter);
    const r = await run(c, 'h1', 'echo hi');
    fake.last().emit('hello');
    await c.waitFor((e) => e.event === 'shell.output');
    const got = await c.call<{ view: ShellView | null }>('shell.get', { sessionId: 'h1' });
    expect(got.view).toMatchObject({ run: { runId: r.runId }, output: 'hello', offset: 0 });
    const opened = await c.call<{ shell?: ShellView }>('chat.open', { sessionId: 'h1', tail: 5 });
    expect(opened.shell).toMatchObject({ output: 'hello', offset: 0 });
    expect((await c.call<{ view: unknown }>('shell.get', { sessionId: 'h2' })).view).toBeNull();
    const other = await c.call<Record<string, unknown>>('chat.open', { sessionId: 'h2', tail: 5 });
    expect('shell' in other).toBe(false);
  });

  it('service shutdown kills a running command without appending', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    const { fake, client: c } = await start(adapter);
    await run(c, 'h1', 'sleep 100');
    const pty = fake.last();
    const session = adapter.lastSession();
    await svc!.close();
    svc = undefined;
    expect(pty.kills.length).toBeGreaterThan(0);
    expect(session.sent).toEqual([]);
  });
});

describe('hello', () => {
  it('hello advertises shell only with a PTY', async () => {
    for (const headless of [false, true]) {
      for (const pty of [fakePtyFactory().factory, null]) {
        const s = await startService({
          dataDir: join(dir, `data-${headless}-${pty === null}`),
          claudeConfigDir: join(dir, 'claude'),
          adapter: new FakeAdapter(),
          installSignalHandlers: false,
          logger,
          shell: { pty },
          ...(headless
            ? { headless: true, host: null, remote: { addresses: ['127.0.0.1'], port: 0 } }
            : {}),
        });
        const c = await TestClient.connect(s.port, s.token);
        const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', {
          protocolVersion: PROTOCOL_VERSION,
          client: 't',
        });
        expect(hello.machine.capabilities.includes('shell'), `${headless} ${pty === null}`).toBe(
          pty !== null,
        );
        await c.close();
        await s.close();
      }
    }
  });
});

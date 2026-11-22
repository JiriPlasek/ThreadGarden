/** The mcp.* methods against the real service wiring, a fake adapter and in-memory project files. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type EventMsg, type McpState } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/logger.js';
import type { McpProjectFiles } from '../../src/mcp/project-files.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { init, settle } from '../chat/live-helpers.js';
import { TestClient } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;
let errors: string[];
let files: Files;

class Files implements McpProjectFiles {
  names: string[] = ['db'];
  approved: { cwd: string; name: string }[] = [];
  async mcpJsonNames(): Promise<string[]> {
    return this.names;
  }
  async approve(cwd: string, name: string): Promise<void> {
    this.approved.push({ cwd, name });
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-mcp-'));
  errors = [];
  files = new Files();
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (m) => void errors.push(m),
  error: (m) => void errors.push(m),
  flush: async () => {},
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
    logger,
    mcpFiles: files,
    ...over,
  });
  client = await TestClient.connect(svc.port, svc.token);
  return client;
};

const create = async (c: TestClient, cwd = dir) =>
  (await c.call<{ sessionId: string }>('chat.create', { cwd, text: 'hi' })).sessionId;

const changed = (id: string) => (e: EventMsg) =>
  e.event === 'mcp.changed' && (e.data as McpState).sessionId === id;
const codexId = 'codex-00000000-0000-0000-0000-000000000000';
const web = {
  name: 'web',
  status: 'needs-auth',
  scope: 'project',
  config: { type: 'http', url: 'x' },
};

describe('mcp.*', () => {
  it('list says not live for a paused chat', async () => {
    const c = await start(new FakeAdapter());
    expect(await c.call('mcp.list', { sessionId: 'paused' })).toEqual({
      sessionId: 'paused',
      live: false,
      servers: [],
      waiting: [],
    });
  });

  it('list builds the state from the session and the files', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    adapter.lastSession().mcpServers = [web] as never;
    const state = await c.call<McpState>('mcp.list', { sessionId: id });
    expect(state.live).toBe(true);
    expect(state.waiting).toEqual(['db']);
    expect(state.servers.map((s) => [s.name, s.status, s.canSignIn])).toEqual([
      ['db', 'unapproved', false],
      ['web', 'needs-auth', true],
    ]);
  });

  it('list refuses a Codex chat', async () => {
    const c = await start(new FakeAdapter());
    await expect(c.call('mcp.list', { sessionId: codexId })).rejects.toMatchObject({
      code: 'MCP_UNSUPPORTED',
    });
  });

  describe('approve', () => {
    it('writes and reconnects in every live chat of the project', async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      const b = await create(c);
      const other = await create(c, join(dir, 'elsewhere'));
      const [sa, sb, so] = adapter.started;
      expect(await c.call('mcp.approve', { sessionId: a, name: 'db' })).toEqual({});
      expect(files.approved).toEqual([{ cwd: dir, name: 'db' }]);
      const recon = (s: typeof sa) => s!.mcpCalls.filter((x) => x.op === 'reconnect');
      expect(recon(sa)).toEqual([{ op: 'reconnect', name: 'db' }]);
      expect(recon(sb)).toEqual([{ op: 'reconnect', name: 'db' }]);
      expect(recon(so)).toEqual([]);
      expect(adapter.started).toHaveLength(3);
      await c.waitFor(changed(a));
      await c.waitFor(changed(b));
      expect(c.events.some(changed(other))).toBe(false);
    });

    it("another chat's reconnect failure doesn't fail the approve", async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      await create(c);
      adapter.started[1]!.mcpError = new Error('Server exploded SECRET-NAME');
      expect(await c.call('mcp.approve', { sessionId: a, name: 'db' })).toEqual({});
      expect(errors.join('\n')).not.toContain('SECRET-NAME');
    });

    it('fails with MCP_FAILED when this chat cannot reconnect', async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      adapter.lastSession().mcpError = new Error('nope');
      await expect(c.call('mcp.approve', { sessionId: a, name: 'db' })).rejects.toMatchObject({
        code: 'MCP_FAILED',
        message: 'nope',
      });
    });

    it('approving twice is harmless', async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      await c.call('mcp.approve', { sessionId: a, name: 'db' });
      await c.call('mcp.approve', { sessionId: a, name: 'db' });
      expect(adapter.started).toHaveLength(1);
    });

    it("during a turn doesn't interrupt it", async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      await c.call('mcp.approve', { sessionId: a, name: 'db' });
      await settle();
      expect(adapter.lastSession().interrupted).toBe(0);
      const statuses = c.events.filter((e) => e.event === 'chat.status');
      expect((statuses.at(-1)!.data as { status: string }).status).toBe('working');
    });

    it('refuses a name not in .mcp.json', async () => {
      const adapter = new FakeAdapter();
      const c = await start(adapter);
      const a = await create(c);
      await expect(c.call('mcp.approve', { sessionId: a, name: 'nope' })).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        message: `"nope" isn't a server in this project's .mcp.json`,
      });
      expect(files.approved).toEqual([]);
    });
  });

  it('signIn returns the link and refreshes', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    const fake = adapter.lastSession();
    fake.mcpServers = [web] as never;
    fake.authResult = { authUrl: 'https://auth.example/start' };
    expect(await c.call('mcp.signIn', { sessionId: id, name: 'web' })).toEqual({
      url: 'https://auth.example/start',
    });
    expect(fake.mcpCalls).toContainEqual({ op: 'authenticate', name: 'web' });
    await c.waitFor(changed(id));
  });

  it('signIn refuses a claude.ai connector', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    adapter.lastSession().mcpServers = [
      {
        name: 'Slack',
        status: 'needs-auth',
        scope: 'claudeai',
        config: { type: 'claudeai-proxy' },
      },
    ] as never;
    await expect(c.call('mcp.signIn', { sessionId: id, name: 'Slack' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('act maps reconnect, enable, disable and clearAuth', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    for (const action of ['reconnect', 'enable', 'disable', 'clearAuth']) {
      expect(await c.call('mcp.act', { sessionId: id, name: 'web', action })).toEqual({});
    }
    expect(adapter.lastSession().mcpCalls.filter((x) => x.op !== 'status')).toEqual([
      { op: 'reconnect', name: 'web' },
      { op: 'toggle', name: 'web', arg: true },
      { op: 'toggle', name: 'web', arg: false },
      { op: 'clearAuth', name: 'web' },
    ]);
  });

  it('never logs a callback URL', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    const url = 'http://localhost:5/cb?code=SECRET';
    adapter.lastSession().mcpError = new Error(`Invalid callback ${url}`);
    await expect(
      c.call('mcp.submitCallback', { sessionId: id, name: 'web', url }),
    ).rejects.toMatchObject({ code: 'MCP_FAILED', message: `Invalid callback ${url}` });
    await settle();
    expect(errors.join('\n')).not.toContain('SECRET');
  });

  it('init emits mcp.changed', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const id = await create(c);
    adapter.lastSession().emit(init(id));
    await c.waitFor(changed(id));
  });

  it('hello advertises mcp, local and headless', async () => {
    for (const over of [{}, { headless: true }]) {
      const c = await start(new FakeAdapter(), over);
      const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', {
        protocolVersion: PROTOCOL_VERSION,
        client: 't',
      });
      expect(hello.machine.capabilities).toContain('mcp');
      await client?.close();
      client = undefined;
      await svc?.close();
      svc = undefined;
    }
  });
});

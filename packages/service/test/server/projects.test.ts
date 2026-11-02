/** The folders.* / projects.* / github.* methods through the real service wiring, with fake git and gh. */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { eventually } from '../e2e/ws-client.js';
import { fakeTools, type Reply } from '../projects/fake-tools.js';

let dir: string;
let code: string;
let svc: ServiceHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-projects-'));
  code = join(dir, 'code');
  await mkdir(code);
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const ghReady: Reply = {
  cmd: 'gh',
  match: /^auth status/,
  result: { stdout: 'Logged in to github.com account me' },
};
const gitInit: Reply = { cmd: 'git', match: /^init/, result: {} };

const start = async (replies: Reply[], over: Partial<StartOptions> = {}) => {
  const tools = fakeTools(replies);
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter: new FakeAdapter(),
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    projectTools: tools,
    ...over,
  });
  return tools;
};

let nextId = 1;
const call = (method: string, params: unknown) =>
  svc!.router.dispatch(
    { id: nextId++, method, params },
    { clientId: 't', origin: 'local' },
  ) as Promise<{
    result?: unknown;
    error?: { code: string; message: string };
  }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};

describe('projects methods', () => {
  it('hello reports the projects capability', async () => {
    await start([]);
    const hello = await ok<{ machine?: { capabilities: string[] } }>('hello', {
      protocolVersion: 7,
      client: 'test',
    });
    expect(hello.machine?.capabilities).toContain('projects');
  });

  it('folders.list over the protocol returns the listing with parent from the service', async () => {
    await start([]);
    await mkdir(join(code, 'alpha'));
    await mkdir(join(code, 'beta'));
    const listing = await ok<{ path: string; parent: string | null; folders: unknown[] }>(
      'folders.list',
      { path: code },
    );
    expect(listing.path).toBe(code);
    expect(listing.parent).toBe(dir);
    expect(JSON.stringify(listing.folders)).toContain('alpha');
    expect(JSON.stringify(listing.folders)).toContain('beta');
  });

  it('folders.complete and folders.create answer in the protocol shapes', async () => {
    await start([]);
    expect(await ok('folders.create', { parent: code, name: 'gamma' })).toEqual({
      path: join(code, 'gamma'),
    });
    expect(await ok('folders.complete', { partial: join(code, 'ga') })).toEqual({
      matches: [join(code, 'gamma')],
    });
  });

  it('projects.create then chat.create starts a chat in the new folder', async () => {
    await start([gitInit]);
    const made = await ok<{ path: string; repo: string | null }>('projects.create', {
      createIn: code,
      name: 'plant',
      github: false,
    });
    expect(made).toEqual({ path: join(code, 'plant'), repo: null, problem: null });
    expect(existsSync(made.path)).toBe(true);
    expect(await ok('projects.createIn', {})).toEqual({ path: code });
    const chat = await ok<{ sessionId: string }>('chat.create', { cwd: made.path, text: 'hi' });
    expect(chat.sessionId).toEqual(expect.any(String));
  });

  it('projects.clone → projects.job polls to done', async () => {
    const tools = await start([ghReady]);
    const started = await ok<{ status: string; job: { jobId: string } }>('projects.clone', {
      createIn: code,
      repo: 'me/thing',
    });
    expect(started.status).toBe('started');
    const { jobId } = started.job;
    expect(await ok('projects.job', { jobId })).toMatchObject({ state: 'running' });
    tools.spawned[0]!.finish({ code: 0 });
    await eventually(async () => {
      const job = (await ok<{ state: string }>('projects.job', { jobId })).state;
      return job === 'done';
    });
    expect(await ok('projects.cancel', { jobId })).toEqual({});
  });

  it('projects.create with Claude missing is CLAUDE_MISSING and makes nothing', async () => {
    await start([gitInit], {
      claude: { problem: 'missing', detail: 'Claude Code was not found on PATH.' },
    });
    const r = await call('projects.create', { createIn: code, name: 'plant', github: false });
    expect(r.error?.code).toBe('CLAUDE_MISSING');
    expect(await readdir(code)).toEqual([]);
  });

  it('github.status and github.repos answer in the protocol shapes', async () => {
    await start([ghReady]);
    expect(await ok('github.status', {})).toMatchObject({ ready: true, login: 'me' });
    expect(await ok('projects.origins', {})).toEqual({ repos: [] });
  });
});

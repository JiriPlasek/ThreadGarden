import { createServer } from 'node:net';
import type { ChatItem, EventMsg } from '@pahub/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockService, type MockService } from '../../src/testing/mock-main.js';
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

    // Plain reply: streamed text, then idle.
    const plain = await c.call<{ sessionId: string }>('chat.create', { cwd: '/work', text: 'hi' });
    await c.waitFor(chatStatus(plain.sessionId, 'idle'), 10_000);
    const reply = itemsOf(c.events, plain.sessionId).find((i) => i.kind === 'assistantText');
    expect(reply).toMatchObject({ streaming: false });
    expect((reply as { markdown: string }).markdown).toMatch(/pahub mock service/);
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
    type Task = { taskId: string; kind: string; status: string; description: string };
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
    });
    await eventually(
      () => (tasksOf(agent.sessionId)?.[0] as { tokens?: number } | undefined)?.tokens,
      5_000,
    );
    await eventually(() => tasksOf(agent.sessionId)?.[0]?.status === 'completed', 8_000);
    await c.waitFor(chatStatus(agent.sessionId, 'idle'), 5_000);
    const calls = itemsOf(c.events, agent.sessionId).filter((i) => i.kind === 'toolCall');
    expect(calls).toEqual([expect.objectContaining({ name: 'Agent', status: 'ok' })]);

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

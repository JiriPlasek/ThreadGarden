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
});

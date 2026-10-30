/**
 * v1.1 "Your turn" (§3), project order and missing folders (§4) through the
 * real service wiring, a fake Claude Code and a WebSocket client.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventMsg } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { result } from '../chat/live-helpers.js';
import { TestClient, chatStatus, eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-turn-'));
});
afterEach(async () => {
  client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

const addHistory = (adapter: FakeAdapter, sessionId: string, cwd: string, lastModified: number) => {
  const m = (uuid: string, type: 'user' | 'assistant', text: string) =>
    ({
      type,
      uuid,
      session_id: sessionId,
      message:
        type === 'user'
          ? { role: 'user', content: text }
          : { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    }) as SessionMessage;
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Chat ${sessionId}`, lastModified, fileSize: 100, cwd },
    messages: [m(`${sessionId}-u`, 'user', 'question'), m(`${sessionId}-a`, 'assistant', 'answer')],
  });
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
    ...over,
  });
  client = await TestClient.connect(svc.port, svc.token);
  const c = client;
  await eventually(async () => {
    const r = await c.call<{ all: number }>('places.counts', {});
    return r.all >= adapter.sessions.size;
  });
  return c;
};

const restart = async (adapter: FakeAdapter) => {
  client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  return start(adapter);
};

const count = (events: EventMsg[], pred: (e: EventMsg) => boolean) => events.filter(pred).length;
const finishedFor = (id: string) => (e: EventMsg) =>
  e.event === 'chatFinished' && (e.data as { sessionId: string }).sessionId === id;
const changedFor = (id: string) => (e: EventMsg) =>
  e.event === 'sessions.changed' && (e.data as { sessionIds: string[] }).sessionIds.includes(id);

describe('your turn (service)', () => {
  it('a finished turn is announced once, lists the chat under Needs you, and markSeen clears it', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the build',
    });
    adapter.lastSession().emit(result('r1'));
    const fin = await c.waitFor(finishedFor(sessionId));
    expect(fin.data).toEqual({
      sessionId,
      title: 'Fix the build',
      projectName: expect.any(String),
    });
    await eventually(async () => {
      const r = await c.call<Any>('sessions.list', { place: { kind: 'needsYou' }, limit: 10 });
      return r.items[0]?.unread === true;
    });
    expect(count(c.events, finishedFor(sessionId))).toBe(1);
    expect((await c.call<Any>('places.counts', {})).needsYou).toBe(1);
    const opened = await c.call<Any>('chat.open', { sessionId, tail: 10 });
    expect(opened.summary).toMatchObject({ status: 'idle', unread: true });

    const before = count(c.events, changedFor(sessionId));
    expect(await c.call('chat.markSeen', { sessionId })).toEqual({});
    await eventually(() => count(c.events, changedFor(sessionId)) === before + 1);
    expect(
      (await c.call<Any>('sessions.list', { place: { kind: 'needsYou' }, limit: 10 })).items,
    ).toEqual([]);
    expect((await c.call<Any>('places.counts', {})).needsYou).toBe(0);
    // Idempotent: nothing changes, nothing is announced.
    await c.call('chat.markSeen', { sessionId });
    await c.call('chat.markSeen', { sessionId: 'unknown-chat' });
    await c.call('places.counts', {});
    expect(count(c.events, changedFor(sessionId))).toBe(before + 1);
  });

  it('sending a message marks the chat seen', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', dir, 1_700_000_000_000);
    const c = await start(adapter);
    const summary = async () =>
      (await c.call<Any>('sessions.summaries', { sessionIds: ['h1'] })).items[0];
    await c.call('chat.send', { sessionId: 'h1', text: 'one' });
    adapter.lastSession().emit(result('r1'));
    await c.waitFor(finishedFor('h1'));
    expect(await summary()).toMatchObject({ status: 'idle', unread: true });
    // Ending the chat is not seeing it: still unread in history.
    await c.call('chat.end', { sessionId: 'h1' });
    expect(await summary()).toMatchObject({ status: 'history', unread: true });
    // Replying is: ended right away, the chat is back in history and no longer unread.
    await c.call('chat.send', { sessionId: 'h1', text: 'two' });
    await c.call('chat.end', { sessionId: 'h1' });
    expect(await summary()).toMatchObject({ status: 'history', unread: false });
  });

  it('a result with a queued follow-up neither announces nor marks unread (R28)', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'one',
    });
    expect(await c.call('chat.send', { sessionId, text: 'two' })).toEqual({ queued: true });
    const fake = adapter.lastSession();
    fake.emit(result('r1'));
    await c.waitFor(chatStatus(sessionId, 'idle'));
    expect(count(c.events, finishedFor(sessionId))).toBe(0);
    const summary = async () =>
      (await c.call<Any>('sessions.summaries', { sessionIds: [sessionId] })).items[0];
    expect(await summary()).toMatchObject({ unread: false });
    expect((await c.call<Any>('places.counts', {})).needsYou).toBe(0);

    fake.emit(result('r2')); // the turn that answered "two" leaves the chat waiting
    await c.waitFor(finishedFor(sessionId));
    expect(await summary()).toMatchObject({ status: 'idle', unread: true });
    expect(count(c.events, finishedFor(sessionId))).toBe(1);
  });

  it('unread state survives a service restart', async () => {
    const adapter = new FakeAdapter();
    let c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'one',
    });
    adapter.lastSession().emit(result('r1'));
    await c.waitFor(finishedFor(sessionId));
    c = await restart(adapter);
    const [chat] = (await c.call<Any>('sessions.list', { place: { kind: 'needsYou' }, limit: 10 }))
      .items;
    // The process went with the old service (failed, §4.2), the unseen turn is still news.
    expect(chat).toMatchObject({ sessionId, status: 'failed', unread: true });
  });

  it('notifyOnFinish defaults to on and can be switched off', async () => {
    const c = await start(new FakeAdapter());
    expect((await c.call<Any>('settings.get', {})).notifyOnFinish).toBe(true);
    expect((await c.call<Any>('settings.set', { notifyOnFinish: false })).notifyOnFinish).toBe(
      false,
    );
    expect((await c.call<Any>('settings.get', {})).notifyOnFinish).toBe(false);
  });
});

describe('project order and missing folders (service)', () => {
  it('a live chat moves its project to the top and projects.changed tells clients', async () => {
    const older = join(dir, 'older');
    const newer = join(dir, 'newer');
    await mkdir(older);
    await mkdir(newer);
    const adapter = new FakeAdapter();
    addHistory(adapter, 'o1', older, 1_700_000_000_000);
    addHistory(adapter, 'n1', newer, 1_700_000_100_000);
    const c = await start(adapter);
    const names = async () =>
      (await c.call<Any[]>('projects.list', {})).map((p) => p.displayName as string);
    expect(await names()).toEqual(['newer', 'older']);

    const changes = () => count(c.events, (e) => e.event === 'projects.changed');
    const before = changes();
    await c.call('chat.send', { sessionId: 'o1', text: 'wake up' });
    await eventually(() => changes() > before);
    expect(await names()).toEqual(['older', 'newer']);
  });

  it('marks projects whose folder is gone', async () => {
    const here = join(dir, 'here');
    await mkdir(here);
    const adapter = new FakeAdapter();
    addHistory(adapter, 'a', here, 1_700_000_000_000);
    addHistory(adapter, 'b', join(dir, 'gone'), 1_700_000_100_000);
    const c = await start(adapter);
    await eventually(async () => {
      const list = await c.call<Any[]>('projects.list', {});
      return list.find((p) => p.displayName === 'gone')?.exists === false;
    });
    const list = await c.call<Any[]>('projects.list', {});
    expect(list.find((p) => p.displayName === 'here')?.exists).toBe(true);
  });
});

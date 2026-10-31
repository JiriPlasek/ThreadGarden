/**
 * End-to-end: the real service (`startService`) with a fake SDK adapter,
 * driven through a real WebSocket client.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, EventMsg } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDiscovery } from '../../src/discovery.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { assistantText, init, result, sdk, streamEvent } from '../chat/live-helpers.js';
import { TestClient, chatStatus, eventually } from './ws-client.js';

let dir: string;
const open: { svc: ServiceHandle[]; clients: TestClient[] } = { svc: [], clients: [] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-e2e-'));
});
afterEach(async () => {
  for (const c of open.clients.splice(0)) await c.close();
  for (const s of open.svc.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

const start = async (adapter: FakeAdapter, over: Partial<StartOptions> = {}) => {
  const svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    installSignalHandlers: false,
    ...over,
  });
  open.svc.push(svc);
  return svc;
};

const connect = async (svc: ServiceHandle) => {
  const c = await TestClient.connect(svc.port, svc.token);
  open.clients.push(c);
  return c;
};

/** Items as a client would hold them: upserted by id, in first-seen order. */
const itemsFrom = (events: EventMsg[], sessionId: string): ChatItem[] => {
  const map = new Map<string, ChatItem>();
  for (const e of events) {
    if (e.event !== 'chat.items') continue;
    const d = e.data as { sessionId: string; items: ChatItem[] };
    if (d.sessionId !== sessionId) continue;
    for (const i of d.items) map.set(i.id, i);
  }
  return [...map.values()];
};

type Opened = { items: ChatItem[]; seq: number; hasMore: boolean; header: { model?: string } };

describe('service end-to-end', () => {
  it('create → stream → result over WebSocket', async () => {
    const adapter = new FakeAdapter();
    const svc = await start(adapter);
    const c = await connect(svc);

    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'hello',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    const fake = adapter.lastSession();
    expect(fake.options).toMatchObject({
      sessionId,
      cwd: dir,
      claudePath: '/bin/claude',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    await c.waitFor(chatStatus(sessionId, 'working'));

    fake.emit(init(sessionId));
    fake.emit(streamEvent('m0', { type: 'message_start', message: { id: 'api1' } }));
    fake.emit(
      streamEvent('b0', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    for (const text of ['Hel', 'lo ', 'there']) {
      fake.emit(
        streamEvent(`d-${text}`, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      );
    }
    fake.emit(
      sdk({
        type: 'assistant',
        uuid: 'a1',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: 'api1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there' }],
        },
      }),
    );
    fake.emit(result('r1'));
    await c.waitFor(chatStatus(sessionId, 'idle'));

    const items = itemsFrom(c.events, sessionId);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistantText', 'result']);
    expect(items[1]).toMatchObject({ id: 'b0', markdown: 'Hello there', streaming: false });

    // Events are numbered consecutively, and chat.open agrees with what was streamed.
    const seqs = c.events
      .filter((e) => e.event === 'chat.items' || e.event === 'chat.status')
      .map((e) => (e.data as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    const opened = await c.call<Opened>('chat.open', { sessionId, tail: 50 });
    expect(opened.items).toEqual(items);
    expect(opened.seq).toBe(seqs.at(-1));
    expect(opened.header.model).toBe('claude-opus-5-5');
    expect(await c.call('chat.since', { sessionId, seq: opened.seq })).toEqual({
      events: [],
      seq: opened.seq,
    });
  });

  it('permission round-trip via chat.respond', async () => {
    const adapter = new FakeAdapter();
    const svc = await start(adapter);
    const c = await connect(svc);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'run it',
    });
    const fake = adapter.lastSession();
    const decision = fake.requestPermission(
      'Bash',
      { command: 'npm test' },
      { requestId: 'req-1', title: 'Run npm test?' },
    );

    const needs = await c.waitFor((e) => e.event === 'needsYou');
    expect(needs.data).toMatchObject({ sessionId, what: 'Run npm test?' });
    await c.waitFor(chatStatus(sessionId, 'needsYou'));
    const counts = await c.call<{ needsYou: number }>('places.counts', {});
    expect(counts.needsYou).toBe(1);

    await c.call('chat.respond', { sessionId, requestId: 'req-1', decision: 'allow' });
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
    await c.waitFor(chatStatus(sessionId, 'working'));
    expect(
      itemsFrom(c.events, sessionId).find((i) => i.kind === 'permissionRequest'),
    ).toMatchObject({ requestId: 'req-1', state: 'allowed' });

    // Answering again is an error the UI can show, not a crash.
    const again = await c.raw('chat.respond', { sessionId, requestId: 'req-1', decision: 'deny' });
    expect(again.error?.code).toBe('NOT_FOUND');
  });

  it('chat.since after reconnect returns missed events', async () => {
    const adapter = new FakeAdapter();
    const svc = await start(adapter);
    const c1 = await connect(svc);
    const { sessionId } = await c1.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'long job',
    });
    const { seq } = await c1.call<Opened>('chat.open', { sessionId, tail: 10 });
    await c1.close();

    const fake = adapter.lastSession();
    fake.emit(assistantText('a1', 'done while you were away'));
    fake.emit(result('r1'));
    await eventually(() => svc.host?.get(sessionId)?.status === 'idle');

    const c2 = await connect(svc);
    // Replayed events are the chat.items / chat.status event payloads, in seq order.
    const missed = await c2.call<{ events: { seq: number; items?: ChatItem[] }[]; seq: number }>(
      'chat.since',
      { sessionId, seq },
    );
    const seqs = missed.events.map((e) => e.seq);
    expect(seqs[0]).toBe(seq + 1);
    expect(seqs).toEqual(seqs.map((_, i) => seq + 1 + i));
    expect(missed.seq).toBe(seqs.at(-1));
    expect(missed.events.flatMap((e) => e.items ?? []).map((i) => i.id)).toEqual(['a1', 'r1']);
    expect(missed.events.at(-1)).toMatchObject({ sessionId, status: 'idle' });
  });

  it('a seq from before a service restart is a gap, never mis-numbered events', async () => {
    const adapter = new FakeAdapter();
    const svc = await start(adapter);
    const c = await connect(svc);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'hi',
    });
    adapter.lastSession().emit(result('r1'));
    await c.waitFor(chatStatus(sessionId, 'idle'));
    const before = await c.call<Opened>('chat.open', { sessionId, tail: 10 });
    await c.close();
    await svc.close();
    open.svc.splice(0);

    // Same data dir: the chat comes back as interrupted, with fresh numbering.
    const svc2 = await start(adapter);
    const c2 = await connect(svc2);
    const stale = await c2.raw('chat.since', { sessionId, seq: before.seq });
    expect(stale.error?.code).toBe('GAP');
    const stale0 = await c2.raw('chat.since', { sessionId, seq: 0 });
    expect(stale0.error?.code).toBe('GAP');
    const now = await c2.call<Opened>('chat.open', { sessionId, tail: 10 });
    expect(now.seq).not.toBe(before.seq);
    expect(await c2.call('chat.since', { sessionId, seq: now.seq })).toEqual({
      events: [],
      seq: now.seq,
    });
  });

  it('work.stopAll ends all sessions', async () => {
    const adapter = new FakeAdapter();
    const svc = await start(adapter);
    const c = await connect(svc);
    const a = await c.call<{ sessionId: string }>('chat.create', { cwd: dir, text: 'one' });
    const b = await c.call<{ sessionId: string }>('chat.create', { cwd: dir, text: 'two' });
    expect(svc.host?.liveCount()).toBe(2);

    expect(await c.call('work.stopAll', {})).toEqual({ stopped: 2 });
    expect(adapter.started.every((s) => s.closed)).toBe(true);
    expect(svc.host?.liveCount()).toBe(0);
    await c.waitFor(chatStatus(a.sessionId, 'history'));
    await c.waitFor(chatStatus(b.sessionId, 'history'));
    expect(await c.call('work.stopAll', {})).toEqual({ stopped: 0 });
  });

  it('service.shutdown removes service.json', async () => {
    const adapter = new FakeAdapter();
    const data = join(dir, 'data');
    const svc = await start(adapter);
    const c = await connect(svc);
    await c.call('chat.create', { cwd: dir, text: 'busy' });
    expect(await readDiscovery(data)).not.toBeNull();

    const closed = new Promise<void>((r) => svc.onClosed(r));
    expect(await c.call('service.shutdown', { stopAll: true })).toEqual({});
    await closed;
    open.svc.splice(0);
    expect(await readDiscovery(data)).toBeNull();
    // stopAll ran first: the session was closed and is not "interrupted" on next start.
    expect(adapter.lastSession().closed).toBe(true);
    const svc2 = await start(adapter);
    expect(svc2.host?.list()).toEqual([]);
  });

  it('idle exit after 30 min with fake clock', async () => {
    const adapter = new FakeAdapter();
    let now = 1_000_000;
    let tick: (() => void) | undefined;
    const svc = await start(adapter, {
      clock: () => now,
      setInterval: (fn) => {
        tick = fn;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    const closed = new Promise<void>((r) => svc.onClosed(r));
    const c = await connect(svc);
    await c.call('chat.create', { cwd: dir, text: 'keep me alive' });
    await c.close();
    await new Promise((r) => setTimeout(r, 50)); // the server sees the disconnect

    // A live session keeps the service up even with no client.
    now += 31 * 60_000;
    tick!();
    expect(await readDiscovery(join(dir, 'data'))).not.toBeNull();

    svc.host!.stopAll();
    now += 29 * 60_000;
    tick!();
    expect(await readDiscovery(join(dir, 'data'))).not.toBeNull();
    now += 60_000;
    tick!();
    await closed;
    open.svc.splice(0);
    expect(await readDiscovery(join(dir, 'data'))).toBeNull();
  });
});

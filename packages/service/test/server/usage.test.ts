/** v1.3 B: usage.* and scheduled.* against the real service wiring and a fake adapter. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIMIT_RESET_MARGIN_MS,
  type ChatItem,
  type ScheduledSend,
  type UsageState,
} from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATE_NOTE, startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { result, sdk, settle } from '../chat/live-helpers.js';
import { eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-usage-'));
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const addHistory = (adapter: FakeAdapter, sessionId: string) => {
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Chat ${sessionId}`, lastModified: 1_700_000_000_000, cwd: dir },
    messages: [
      {
        type: 'user',
        uuid: `${sessionId}-u0`,
        session_id: sessionId,
        message: { role: 'user', content: 'question' },
        parent_tool_use_id: null,
        parent_agent_id: null,
      } as SessionMessage,
    ],
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
  await eventually(async () => {
    const r = await call('places.counts', {});
    return (r.result as { all: number } | undefined)?.all === adapter.sessions.size;
  });
  return svc;
};

let nextId = 1;
const call = (method: string, params: unknown) =>
  svc!.router.dispatch({ id: nextId++, method, params }, { clientId: 't' }) as Promise<{
    result?: unknown;
    error?: { code: string; message: string };
  }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};

const rateLimit = (info: Record<string, unknown>) =>
  sdk({
    type: 'rate_limit_event',
    uuid: `rl-${nextId++}`,
    session_id: 'h1',
    rate_limit_info: info,
  });
const refusedReply = () =>
  sdk({
    type: 'assistant',
    uuid: `refused-${nextId++}`,
    session_id: 'h1',
    parent_tool_use_id: null,
    error: 'rate_limit',
    message: {
      id: `msg-${nextId}`,
      role: 'assistant',
      content: [{ type: 'text', text: "You've hit your limit" }],
    },
  });

describe('usage and scheduled sends (service)', () => {
  it('rate-limit events of a live chat become the account usage, kept across restarts', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    await ok('chat.send', { sessionId: 'h1', text: 'go' });
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    adapter.lastSession().emit(
      rateLimit({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.9,
        resetsAt,
      }),
    );
    await settle();
    const state = await ok<UsageState>('usage.get', {});
    expect(state.windows).toEqual([
      expect.objectContaining({
        key: 'five_hour',
        status: 'allowed_warning',
        utilization: 90,
        resetsAt: resetsAt * 1000,
      }),
    ]);
    await svc!.close();
    svc = undefined;
    await start(adapter);
    expect((await ok<UsageState>('usage.get', {})).windows[0]?.utilization).toBe(90);
  });

  it('usage.get with refresh reads a running chat, and never starts one', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    expect(await ok<UsageState>('usage.get', { refresh: true })).toEqual({
      windows: [],
      refused: [],
    });
    expect(adapter.started).toHaveLength(0);
    await ok('chat.send', { sessionId: 'h1', text: 'go' });
    adapter.lastSession().usage = async () => ({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 37, resets_at: '2030-01-01T00:00:00Z' } },
    });
    const state = await ok<UsageState>('usage.get', { refresh: true });
    expect(state).toMatchObject({ subscriptionType: 'max', rateLimitsAvailable: true });
    expect(state.windows[0]).toMatchObject({ key: 'five_hour', utilization: 37, source: 'usage' });
  });

  it('a refused turn marks the chat until a later turn goes through', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    await ok('chat.send', { sessionId: 'h1', text: 'go' });
    const fake = adapter.lastSession();
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    fake.emit(rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }));
    fake.emit(refusedReply());
    fake.emit(result('r1', { is_error: true }));
    await settle();
    expect((await ok<UsageState>('usage.get', {})).refused).toEqual([
      expect.objectContaining({ sessionId: 'h1', resetsAt: resetsAt * 1000 }),
    ]);
    await ok('chat.send', { sessionId: 'h1', text: 'again' });
    fake.emit(rateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt }));
    fake.emit(result('r2'));
    await settle();
    expect((await ok<UsageState>('usage.get', {})).refused).toEqual([]);
  });

  it('a scheduled send resumes a history chat through chat.send and is gone once answered', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    const created = await ok<ScheduledSend>('scheduled.create', {
      sessionId: 'h1',
      text: 'continue',
      images: [{ mediaType: 'image/png', data: 'AA==' }],
      sendAt: Date.now(),
    });
    // Due at once: it is already going out when the call answers.
    expect(created).toMatchObject({ state: 'sending', imageCount: 1 });
    await eventually(() => adapter.started.length === 1);
    const fake = adapter.lastSession();
    expect(fake.options.resume).toBe('h1');
    await eventually(() => fake.sent.length === 1);
    const opened = await ok<{ items: ChatItem[] }>('chat.open', { sessionId: 'h1', tail: 10 });
    expect(opened.items.at(-1)).toMatchObject({ kind: 'user', text: 'continue' });
    expect((await ok<{ items: ScheduledSend[] }>('scheduled.list', {})).items).toEqual([
      expect.objectContaining({ state: 'sending' }),
    ]);
    fake.emit(result('r1'));
    await eventually(
      async () => (await ok<{ items: unknown[] }>('scheduled.list', {})).items.length === 0,
    );
  });

  it('a scheduled send the limit refuses waits for the new reset', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    const s = await ok<ScheduledSend>('scheduled.create', {
      sessionId: 'h1',
      text: 'continue',
      sendAt: Date.now(),
    });
    await eventually(() => adapter.started[0]?.sent.length === 1);
    const fake = adapter.lastSession();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fake.emit(rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }));
    fake.emit(refusedReply());
    fake.emit(result('r1', { is_error: true }));
    await eventually(async () => {
      const [item] = (await ok<{ items: ScheduledSend[] }>('scheduled.list', {})).items;
      return item?.state === 'pending';
    });
    const [item] = (await ok<{ items: ScheduledSend[] }>('scheduled.list', { sessionId: 'h1' }))
      .items;
    expect(item).toMatchObject({
      id: s.id,
      rescheduled: true,
      afterLimitReset: true,
      sendAt: resetsAt * 1000 + LIMIT_RESET_MARGIN_MS,
    });
    // "Send when the limit resets" uses the same reset time.
    const later = await ok<ScheduledSend>('scheduled.create', {
      sessionId: 'h1',
      text: 'and this',
      whenLimitResets: true,
    });
    expect(later.sendAt).toBe(resetsAt * 1000 + LIMIT_RESET_MARGIN_MS);
    await ok('scheduled.cancel', { id: later.id });
    expect((await call('scheduled.get', { id: later.id })).error?.code).toBe('NOT_FOUND');
  });

  it('a send due while the service was stopped goes out at start, marked late', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    await start(adapter);
    await ok('scheduled.create', {
      sessionId: 'h1',
      text: 'late one',
      sendAt: Date.now() + 60_000,
    });
    await svc!.close();
    svc = undefined;
    const t0 = Date.now();
    await start(adapter, { clock: () => t0 + 120_000 });
    await eventually(() => adapter.started[0]?.sent.length === 1);
    const opened = await ok<{ items: ChatItem[] }>('chat.open', { sessionId: 'h1', tail: 10 });
    expect(opened.items.some((i) => i.kind === 'system' && i.text === LATE_NOTE)).toBe(true);
  });

  it('a pending scheduled send keeps the service from exiting on idle', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1');
    let now = Date.now();
    const ticks: (() => void)[] = [];
    await start(adapter, {
      clock: () => now,
      setInterval: (fn) => {
        ticks.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    const s = await ok<ScheduledSend>('scheduled.create', {
      sessionId: 'h1',
      text: 'tomorrow',
      sendAt: now + 24 * 3_600_000,
    });
    const closed = { value: false };
    svc!.onClosed(() => (closed.value = true));
    now += 31 * 60_000;
    ticks[0]!();
    now += 31 * 60_000;
    ticks[0]!();
    await settle();
    expect(closed.value).toBe(false);
    await ok('scheduled.cancel', { id: s.id });
    now += 31 * 60_000;
    ticks[0]!();
    await eventually(() => closed.value);
    svc = undefined;
  });
});

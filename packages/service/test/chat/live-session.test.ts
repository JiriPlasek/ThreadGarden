import { describe, expect, it, vi } from 'vitest';
import type { ChatItem, ChatTask, EventMsg } from '@pahub/protocol';
import { LiveSession, authLabel, type LiveSessionOptions } from '../../src/chat/live-session.js';
import { ServiceError } from '../../src/server/router.js';
import type { PermissionUpdate } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import {
  ManualTimers,
  MemoryRegistry,
  assistantText,
  init,
  result,
  level,
  notification,
  progress,
  sdk,
  settle,
  started,
  statuses,
  streamEvent,
} from './live-helpers.js';

const setup = (over: Partial<LiveSessionOptions> = {}) => {
  const adapter = new FakeAdapter();
  const registry = new MemoryRegistry();
  const timers = new ManualTimers();
  const events: EventMsg[] = [];
  /** Clock time of each emitted chat.items event. */
  const itemEmitTimes: number[] = [];
  const opts: LiveSessionOptions = {
    adapter,
    registry,
    claudePath: '/bin/claude',
    env: { FOO: 'bar' },
    emit: (e) => {
      events.push(e);
      if (e.event === 'chat.items') itemEmitTimes.push(timers.now());
    },
    now: timers.now,
    timers,
    ...over,
  };
  return { adapter, registry, timers, events, itemEmitTimes, opts };
};

const collapse = (xs: string[]): string[] => xs.filter((x, i) => x !== xs[i - 1]);

const itemsOf = (events: EventMsg[]): ChatItem[] =>
  events
    .filter((e) => e.event === 'chat.items')
    .flatMap((e) => (e.data as { items: ChatItem[] }).items);

/** Latest version of the item with this id among emitted chat.items events. */
const latest = (events: EventMsg[], id: string): ChatItem | undefined =>
  itemsOf(events)
    .filter((i) => i.id === id)
    .at(-1);

const seqOf = (e: EventMsg): number => (e.data as { seq: number }).seq;
const chatEvents = (events: EventMsg[]) =>
  events.filter(
    (e) => e.event === 'chat.items' || e.event === 'chat.status' || e.event === 'chat.tasks',
  );

const suggestion = (toolName: string): PermissionUpdate => ({
  type: 'addRules',
  rules: [{ toolName }],
  behavior: 'allow',
  destination: 'localSettings',
});

describe('LiveSession', () => {
  it('create sends first message and emits working then idle', async () => {
    const { adapter, registry, timers, events, opts } = setup();
    const s = LiveSession.create(
      '/work/proj',
      { text: 'hello', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
      { ...opts, model: 'claude-opus-5-5', effort: 'high', permissionMode: 'acceptEdits' },
    );
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.cwd).toBe('/work/proj');

    const fake = adapter.lastSession();
    expect(fake.options).toMatchObject({
      cwd: '/work/proj',
      sessionId: s.sessionId,
      claudePath: '/bin/claude',
      env: { FOO: 'bar' },
      model: 'claude-opus-5-5',
      effort: 'high',
      permissionMode: 'acceptEdits',
    });
    expect(fake.options.resume).toBeUndefined();
    expect(registry.live.get(s.sessionId)).toBe('/work/proj');

    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0]!;
    expect(sent).not.toHaveProperty('client_composed');
    expect(sent.priority).toBeUndefined();
    expect(sent.message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
    // The user's message shows immediately, under the uuid sent to the SDK (so an echo upserts).
    expect(latest(events, sent.uuid!)).toMatchObject({
      kind: 'user',
      text: 'hello',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
    expect(s.status).toBe('working');
    expect(s.idleSince).toBeNull();

    fake.emit(init(s.sessionId));
    fake.emit(assistantText('a1', 'Hi there'));
    timers.advance(5);
    fake.emit(result('r1'));
    await settle();

    expect(s.status).toBe('idle');
    expect(s.idleSince).toBe(timers.now());
    expect(collapse(statuses(events))).toEqual(['working', 'idle']);
    expect(latest(events, 'a1')).toMatchObject({ kind: 'assistantText', markdown: 'Hi there' });
    expect(latest(events, 'r1')).toMatchObject({ kind: 'result', isError: false });
  });

  it('sends text-only input without an empty image list and images-only without an empty text block', () => {
    const { adapter, opts } = setup();
    LiveSession.create('/p', { text: 'just text' }, opts);
    expect(adapter.lastSession().sent[0]!.message.content).toEqual([
      { type: 'text', text: 'just text' },
    ]);
    LiveSession.create(
      '/p',
      { text: '', images: [{ mediaType: 'image/jpeg', dataBase64: 'B' }] },
      opts,
    );
    expect(adapter.lastSession().sent[0]!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B' } },
    ]);
  });

  it('send while working queues with priority next', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'first' }, opts);
    const fake = adapter.lastSession();

    expect(s.send({ text: 'second' })).toEqual({ queued: true });
    expect(fake.sent[1]).toMatchObject({ type: 'user', priority: 'next' });
    expect(fake.sent[1]!.message.content).toEqual([{ type: 'text', text: 'second' }]);
    expect(s.status).toBe('working');

    fake.emit(result('r1'));
    await settle();
    expect(s.status).toBe('idle');

    expect(s.send({ text: 'third' })).toEqual({ queued: false });
    expect(fake.sent[2]!.priority).toBeUndefined();
    expect(s.status).toBe('working');
  });

  it('goes back to working when a queued message starts a new turn after idle', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'first' }, opts);
    const fake = adapter.lastSession();
    fake.emit(result('r1'));
    await settle();
    expect(s.status).toBe('idle');
    fake.emit(assistantText('a2', 'answering the queued message'));
    await settle();
    expect(s.status).toBe('working');
  });

  it('permission request sets needsYou, emits needsYou event, resolves allow', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/work/my-proj', { text: 'list the files' }, opts);
    const fake = adapter.lastSession();

    const decision = fake.requestPermission(
      'Bash',
      { command: 'ls' },
      { requestId: 'req-1', title: 'Claude wants to run ls', decisionReason: 'not in allow list' },
    );
    await settle();

    expect(s.status).toBe('needsYou');
    const pending = s.pendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'permissionRequest',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      title: 'Claude wants to run ls',
      decisionReason: 'not in allow list',
      suggestions: [],
      state: 'pending',
      variant: 'tool',
    });
    expect(events.find((e) => e.event === 'needsYou')?.data).toEqual({
      sessionId: s.sessionId,
      title: 'list the files',
      projectName: 'my-proj',
      what: 'Claude wants to run ls',
    });
    const needsYouStatus = events.find(
      (e) => e.event === 'chat.status' && (e.data as { status: string }).status === 'needsYou',
    );
    expect(needsYouStatus?.data).toMatchObject({ waitingFor: 'Claude wants to run ls' });

    s.respond('req-1', { decision: 'allow' });
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
    expect(s.status).toBe('working');
    expect(s.pendingRequests()).toEqual([]);
    expect(latest(events, pending[0]!.id)).toMatchObject({ state: 'allowed' });
  });

  it('stays needsYou until every pending request is answered', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const a = fake.requestPermission('Read', { file_path: 'a' }, { requestId: 'a' });
    const b = fake.requestPermission('Read', { file_path: 'b' }, { requestId: 'b' });
    await settle();
    s.respond('a', { decision: 'allow' });
    await a;
    expect(s.status).toBe('needsYou');
    // Stream activity does not hide an open question.
    fake.emit(assistantText('x', 'meanwhile'));
    await settle();
    expect(s.status).toBe('needsYou');
    s.respond('b', { decision: 'allow' });
    await b;
    expect(s.status).toBe('working');
  });

  it('allowAlways returns the chosen suggestion as updatedPermissions', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const suggestions = [suggestion('Bash(ls:*)'), suggestion('Bash(git:*)')];

    const chosen = fake.requestPermission(
      'Bash',
      { command: 'git status' },
      {
        requestId: 'r1',
        suggestions,
      },
    );
    await settle();
    expect(s.pendingRequests()[0]).toMatchObject({ suggestions });
    s.respond('r1', { decision: 'allowAlways', suggestionIndex: 1 });
    await expect(chosen).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [suggestions[1]],
    });

    const first = fake.requestPermission(
      'Bash',
      { command: 'ls' },
      { requestId: 'r2', suggestions },
    );
    await settle();
    s.respond('r2', { decision: 'allowAlways' });
    await expect(first).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [suggestions[0]],
    });
  });

  it('deny returns message and item state denied', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();

    const plain = fake.requestPermission('Write', { file_path: 'x' }, { requestId: 'd1' });
    await settle();
    const id = s.pendingRequests()[0]!.id;
    s.respond('d1', { decision: 'deny' });
    await expect(plain).resolves.toEqual({ behavior: 'deny', message: 'Denied by user in pahub' });
    expect(latest(events, id)).toMatchObject({ state: 'denied' });

    const reasoned = fake.requestPermission('Write', { file_path: 'y' }, { requestId: 'd2' });
    await settle();
    s.respond('d2', { decision: 'deny', reason: 'use the other file' });
    await expect(reasoned).resolves.toEqual({ behavior: 'deny', message: 'use the other file' });
  });

  it('rejects a response to an unknown request id', () => {
    const { opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    expect(() => s.respond('nope', { decision: 'allow' })).toThrow(/no pending request/i);
  });

  it('AskUserQuestion becomes variant question and passes updatedInput', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const input = { questions: [{ question: 'Which DB?', options: [{ label: 'sqlite' }] }] };

    const answer = fake.requestPermission('AskUserQuestion', input, { requestId: 'q1' });
    await settle();
    expect(s.pendingRequests()[0]).toMatchObject({
      variant: 'question',
      toolName: 'AskUserQuestion',
    });
    const needsYou = events.filter((e) => e.event === 'needsYou').at(-1);
    expect((needsYou?.data as { what: string }).what).toBe('Answer a question: Which DB?');

    const updatedInput = { ...input, answers: { 'Which DB?': 'sqlite' } };
    s.respond('q1', { decision: 'allow', updatedInput });
    await expect(answer).resolves.toEqual({ behavior: 'allow', updatedInput });

    const plan = fake.requestPermission('ExitPlanMode', { plan: '1. do it' }, { requestId: 'p1' });
    await settle();
    expect(s.pendingRequests()[0]).toMatchObject({ variant: 'plan' });
    s.respond('p1', { decision: 'deny', reason: 'keep planning' });
    await expect(plan).resolves.toEqual({ behavior: 'deny', message: 'keep planning' });
  });

  it('abort signal cancels pending request', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const ac = new AbortController();

    const decision = fake.requestPermission(
      'Bash',
      { command: 'rm -rf x' },
      {
        requestId: 'c1',
        signal: ac.signal,
      },
    );
    await settle();
    const id = s.pendingRequests()[0]!.id;
    expect(s.status).toBe('needsYou');

    ac.abort();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    expect(s.pendingRequests()).toEqual([]);
    expect(latest(events, id)).toMatchObject({ state: 'cancelled' });
    expect(s.status).toBe('working');
    expect(() => s.respond('c1', { decision: 'allow' })).toThrow();
  });

  it('cancels immediately when the signal is already aborted', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const ac = new AbortController();
    ac.abort();
    const decision = adapter
      .lastSession()
      .requestPermission('Bash', { command: 'x' }, { requestId: 'c2', signal: ac.signal });
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    expect(s.pendingRequests()).toEqual([]);
    expect(s.status).toBe('working');
  });

  it('interrupt calls session.interrupt', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    await s.interrupt();
    expect(adapter.lastSession().interrupted).toBe(1);
  });

  it('adapter session error marks only that chat failed', async () => {
    const { adapter, registry, events, opts } = setup();
    const a = LiveSession.create('/a', { text: 'one' }, opts);
    const fakeA = adapter.lastSession();
    const b = LiveSession.create('/b', { text: 'two' }, opts);
    const pending = fakeA.requestPermission('Bash', { command: 'x' }, { requestId: 'pa' });
    await settle();

    fakeA.end(new Error('claude process exited with code 1'));
    await settle();
    await a.whenEnded();

    expect(a.status).toBe('failed');
    expect(a.live).toBe(false);
    expect(b.status).toBe('working');
    expect(b.live).toBe(true);
    expect(registry.live.has(a.sessionId)).toBe(false);
    expect(registry.live.has(b.sessionId)).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    const errorItem = itemsOf(events).find((i) => i.kind === 'system' && i.level === 'error');
    expect(errorItem).toMatchObject({ text: expect.stringContaining('claude process exited') });
    expect(() => a.send({ text: 'again' })).toThrow(/not live/i);
  });

  it('marks the chat failed when the stream ends without being asked to', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    adapter.lastSession().end();
    await s.whenEnded();
    expect(s.status).toBe('failed');
  });

  it('maps a startup failure result to an explained error and failed status', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(
      result('r-start', {
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        errors: ['Claude Code 2.0.1 is below the minimum version 2.1.0'],
        startup_failure_reason: 'cli_version_too_old',
      }),
    );
    fake.end(new Error('Claude Code process exited with code 1'));
    await s.whenEnded();

    expect(s.status).toBe('failed');
    expect(s.startupFailure).toMatchObject({ reason: 'cli_version_too_old', setup: true });
    const errors = itemsOf(events).filter((i) => i.kind === 'system' && i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      text: expect.stringContaining(s.startupFailure!.title),
    });
    expect(errors[0]).toMatchObject({ text: expect.stringContaining('minimum version 2.1.0') });
    // The UI shows its setup screen for this chat (§6.4).
    expect(errors[0]).toMatchObject({ setup: true });
  });

  it('resume of a session held by a background process fails with an explanation', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.resume('held-id', '/p', opts);
    adapter.lastSession().emit(
      result('r-held', {
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        errors: ['session is running as a background session'],
        startup_failure_reason: 'session_held_by_background',
      }),
    );
    adapter.lastSession().end(new Error('Claude Code process exited with code 1'));
    await s.whenEnded();

    expect(s.status).toBe('failed');
    expect(s.startupFailure).toMatchObject({
      reason: 'session_held_by_background',
      title: 'Chat is running in the background',
      setup: false,
    });
    const errors = itemsOf(events).filter((i) => i.kind === 'system' && i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ text: expect.stringContaining('background session') });
  });

  it('shows the raw reason for a startup failure this pahub does not know', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(
      result('r-start', {
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        startup_failure_reason: 'future_reason',
      }),
    );
    fake.end();
    await s.whenEnded();
    expect(s.status).toBe('failed');
    expect(s.startupFailure).toMatchObject({ reason: 'future_reason', setup: false });
    const error = itemsOf(events).find((i) => i.kind === 'system' && i.level === 'error');
    expect(error).toMatchObject({ text: expect.stringContaining('future_reason') });
  });

  it('has no startup failure for an ordinary error result', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    adapter.lastSession().emit(result('r1', { subtype: 'error_max_turns', is_error: true }));
    await settle();
    expect(s.startupFailure).toBeUndefined();
    expect(s.status).toBe('idle');
  });

  it('end closes the process, cancels pending requests and returns to history', async () => {
    const { adapter, registry, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const pending = fake.requestPermission('Bash', { command: 'x' }, { requestId: 'e1' });
    await settle();
    const id = s.pendingRequests()[0]!.id;

    s.end();
    await s.whenEnded();
    expect(fake.closed).toBe(true);
    expect(s.status).toBe('history');
    expect(s.live).toBe(false);
    expect(registry.live.has(s.sessionId)).toBe(false);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(latest(events, id)).toMatchObject({ state: 'cancelled' });
  });

  it('resume starts the SDK with resume and the same session id, idle until a message', () => {
    const { adapter, registry, opts } = setup();
    const s = LiveSession.resume('sess-1', '/p', opts);
    const fake = adapter.lastSession();
    expect(s.sessionId).toBe('sess-1');
    expect(fake.options.resume).toBe('sess-1');
    expect(fake.options.sessionId).toBeUndefined();
    expect(fake.sent).toEqual([]);
    expect(s.status).toBe('idle');
    expect(registry.live.get('sess-1')).toBe('/p');
    expect(s.send({ text: 'continue' })).toEqual({ queued: false });
    expect(s.status).toBe('working');
  });

  it('replays events after seq without gaps or duplicates', async () => {
    const { adapter, timers, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(init(s.sessionId));
    fake.emit(streamEvent('m', { type: 'message_start', message: { id: 'api1' } }));
    fake.emit(
      streamEvent('b', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    for (let i = 0; i < 30; i++) {
      fake.emit(
        streamEvent(`d${i}`, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${i} ` },
        }),
      );
      await settle();
      timers.advance(10);
    }
    fake.emit(result('r'));
    await settle();

    const emitted = chatEvents(events);
    const seqs = emitted.map(seqOf);
    expect(seqs).toEqual(Array.from({ length: emitted.length }, (_, i) => i + 1));
    expect(s.since(0)).toEqual(emitted);
    for (const k of [1, 5, Math.floor(emitted.length / 2), emitted.length]) {
      expect(s.since(k)).toEqual(emitted.slice(k));
    }
  });

  it('coalesces a burst of streaming deltas into at most one chat.items emit per 33 ms', async () => {
    const { adapter, timers, events, itemEmitTimes: emitTimes, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    emitTimes.length = 0;
    timers.advance(100);

    fake.emit(streamEvent('m', { type: 'message_start', message: { id: 'api1' } }));
    fake.emit(
      streamEvent('b', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    // 100 deltas in one tick: one leading emit at most, the rest wait for the window.
    for (let i = 0; i < 100; i++) {
      fake.emit(
        streamEvent(`d${i}`, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x' },
        }),
      );
    }
    await settle();
    expect(emitTimes.length).toBeLessThanOrEqual(1);
    timers.advance(33);
    expect(latest(events, 'b')).toMatchObject({ markdown: 'x'.repeat(100), streaming: true });

    // Steady trickle: one delta every 5 ms for 300 ms.
    for (let i = 0; i < 60; i++) {
      fake.emit(
        streamEvent(`t${i}`, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'y' },
        }),
      );
      await settle();
      timers.advance(5);
    }
    timers.advance(33);
    for (let i = 1; i < emitTimes.length; i++) {
      expect(emitTimes[i]! - emitTimes[i - 1]!).toBeGreaterThanOrEqual(33);
    }
    expect(emitTimes.length).toBeLessThanOrEqual(1 + Math.ceil((300 + 33 + 33) / 33));
    expect(latest(events, 'b')).toMatchObject({
      markdown: 'x'.repeat(100) + 'y'.repeat(60),
    });
    expect(s.status).toBe('working');
  });

  it('flushes coalesced items before a status change so order is preserved', async () => {
    const { adapter, events, opts } = setup();
    LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(assistantText('a1', 'first'));
    fake.emit(assistantText('a2', 'second'));
    fake.emit(result('r1'));
    await settle();
    const idleAt = events.findIndex(
      (e) => e.event === 'chat.status' && (e.data as { status: string }).status === 'idle',
    );
    const itemsAt = events.findIndex(
      (e) =>
        e.event === 'chat.items' &&
        (e.data as { items: ChatItem[] }).items.some((i) => i.id === 'r1'),
    );
    expect(itemsAt).toBeGreaterThanOrEqual(0);
    expect(itemsAt).toBeLessThan(idleAt);
  });

  it('maintains header info from init, status and result and emits it via chat.status', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, { ...opts, effort: 'medium' });
    const fake = adapter.lastSession();
    const headers = () =>
      events
        .filter((e) => e.event === 'chat.status')
        .map((e) => (e.data as { header?: unknown }).header);

    fake.emit(init(s.sessionId, { permissionMode: 'acceptEdits' }));
    await settle();
    expect(headers().at(-1)).toEqual({
      model: 'claude-opus-5-5',
      permissionMode: 'acceptEdits',
      claudeVersion: '2.9.0',
      effort: 'medium',
      auth: { kind: 'other', label: 'Unknown' }, // FakeSession's empty account info
    });

    const before = headers().length;
    fake.emit(init(s.sessionId, { permissionMode: 'acceptEdits' }));
    await settle();
    expect(headers().length).toBe(before); // unchanged header → no event

    fake.emit(
      sdk({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: 'plan',
        uuid: 'st',
        session_id: 's',
      }),
    );
    await settle();
    expect(s.header.permissionMode).toBe('plan');
    expect(headers().at(-1)).toMatchObject({ permissionMode: 'plan' });

    fake.emit(
      assistantText('a1', 'hi', {
        input_tokens: 10,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 20000,
        output_tokens: 90,
      }),
    );
    fake.emit(
      result('r1', {
        total_cost_usd: 0.42,
        modelUsage: { 'claude-opus-5-5': { contextWindow: 200000, inputTokens: 10 } },
      }),
    );
    await settle();
    expect(s.header).toMatchObject({
      costUsd: 0.42,
      contextUsage: { used: 21100, max: 200000 },
    });
    expect(headers().at(-1)).toMatchObject({ costUsd: 0.42 });

    s.setAuth({ kind: 'subscription', label: 'Claude Max' });
    expect(headers().at(-1)).toMatchObject({ auth: { kind: 'subscription', label: 'Claude Max' } });
  });

  it('rejects bypassPermissions when creating or resuming, before starting a process', () => {
    const { adapter, registry, opts } = setup();
    const bypass = { ...opts, permissionMode: 'bypassPermissions' as const };
    for (const start of [
      () => LiveSession.create('/p', { text: 'go' }, bypass),
      () => LiveSession.resume('sess-1', '/p', bypass),
    ]) {
      let caught: unknown;
      try {
        start();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServiceError);
      expect(caught).toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(/bypassPermissions/),
      });
    }
    expect(adapter.started).toEqual([]);
    expect(registry.live.size).toBe(0);
  });

  it('rejects setPermissionMode(bypassPermissions) and keeps the current mode', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, { ...opts, permissionMode: 'default' });
    const fake = adapter.lastSession();
    await expect(s.setPermissionMode('bypassPermissions')).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'INVALID_PARAMS',
    });
    expect(fake.permissionMode).toBe('default');
    expect(s.choices.permissionMode).toBe('default');
  });

  it('setModel, setPermissionMode and setEffort apply live and update the header', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();

    await s.setModel('claude-sonnet-5');
    expect(fake.model).toBe('claude-sonnet-5');
    expect(s.header.model).toBe('claude-sonnet-5');

    await s.setPermissionMode('plan');
    expect(fake.permissionMode).toBe('plan');
    expect(s.header.permissionMode).toBe('plan');

    await s.setEffort('high');
    const last = fake.sent.at(-1)!;
    expect(last.message.content).toEqual([{ type: 'text', text: '/effort high' }]);
    expect(last).not.toHaveProperty('client_composed');
    expect(s.header.effort).toBe('high');
  });

  it('snapshot returns the tail of items with the current seq, status and header', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(assistantText('a1', 'one'));
    fake.emit(assistantText('a2', 'two'));
    fake.emit(assistantText('a3', 'three'));
    await settle();

    const snap = s.snapshot(2);
    expect(snap.items.map((i) => i.id)).toEqual(['a2', 'a3']);
    expect(snap.hasMore).toBe(true);
    expect(snap.status).toBe('working');
    expect(snap.seq).toBe(s.seq);
    // Nothing is held back: everything up to snap.seq is in the log.
    expect(s.since(snap.seq)).toEqual([]);
    expect(s.snapshot(10).hasMore).toBe(false);
  });

  it('sets the header auth from accountInfo once per process, after init', async () => {
    const { adapter, opts, events } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.account = { subscriptionType: 'max', apiProvider: 'firstParty' };
    const spy = vi.spyOn(fake, 'accountInfo');
    expect(spy).not.toHaveBeenCalled();
    fake.emit(init(s.sessionId));
    fake.emit(init(s.sessionId));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.header.auth).toEqual({ kind: 'subscription', label: 'Max subscription' });
    const last = events.filter((e) => e.event === 'chat.status').at(-1);
    expect(last?.data).toMatchObject({ header: { auth: { kind: 'subscription' } } });
  });

  it('reports a failing accountInfo without an auth label', async () => {
    const errors: string[] = [];
    const { adapter, opts } = setup({ onError: (_e, ctx) => errors.push(ctx) });
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.accountInfo = () => Promise.reject(new Error('no account'));
    fake.emit(init(s.sessionId));
    await settle();
    expect(s.header.auth).toBeUndefined();
    expect(errors).toEqual([`accountInfo (session ${s.sessionId})`]);
  });

  it('authLabel: API key wins, then a claude.ai login, then the provider', () => {
    expect(authLabel({ apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'claude.ai' })).toEqual({
      kind: 'apiKey',
      label: 'API key',
    });
    expect(authLabel({ apiKeySource: 'apiKeyHelper' })).toEqual({
      kind: 'apiKey',
      label: 'API key (apiKeyHelper)',
    });
    expect(authLabel({ subscriptionType: 'pro' })).toEqual({
      kind: 'subscription',
      label: 'Pro subscription',
    });
    expect(authLabel({ tokenSource: 'claude.ai' })).toEqual({
      kind: 'subscription',
      label: 'Subscription',
    });
    expect(authLabel({ apiKeySource: 'none', apiProvider: 'bedrock' })).toEqual({
      kind: 'other',
      label: 'Amazon Bedrock',
    });
    expect(authLabel({})).toEqual({ kind: 'other', label: 'Unknown' });
  });

  it('never offers or applies a setMode → bypassPermissions suggestion (R11)', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    const bypass: PermissionUpdate = {
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    };
    const rule = suggestion('Bash(ls:*)');
    const chosen = fake.requestPermission(
      'Bash',
      { command: 'ls' },
      { requestId: 'r1', suggestions: [bypass, rule] },
    );
    await settle();
    expect(s.pendingRequests()[0]).toMatchObject({ suggestions: [rule] });
    s.respond('r1', { decision: 'allowAlways', suggestionIndex: 0 });
    await expect(chosen).resolves.toEqual({ behavior: 'allow', updatedPermissions: [rule] });
  });

  it('rejects allowAlways with a suggestion index that does not exist', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    void fake.requestPermission(
      'Bash',
      { command: 'ls' },
      { requestId: 'r1', suggestions: [suggestion('Bash(ls:*)')] },
    );
    await settle();
    expect(() => s.respond('r1', { decision: 'allowAlways', suggestionIndex: 3 })).toThrow(
      ServiceError,
    );
    expect(s.pendingRequests()).toHaveLength(1);
  });

  it('maps a streamed item id to its SDK message uuid and back', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(streamEvent('st', { type: 'message_start', message: { id: 'api1' } }));
    fake.emit(
      streamEvent('sb', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    fake.emit(
      sdk({
        type: 'assistant',
        uuid: 'final',
        session_id: 's',
        parent_tool_use_id: null,
        message: { id: 'api1', role: 'assistant', content: [{ type: 'text', text: 'hey' }] },
      }),
    );
    await settle();
    expect(s.messageUuidOf('sb')).toBe('final');
    expect(s.resolveItemId('final')).toBe('sb');
  });
});

const taskEvents = (events: EventMsg[]) =>
  events
    .filter((e) => e.event === 'chat.tasks')
    .map((e) => e.data as { sessionId: string; seq: number; tasks: ChatTask[] });
const lastTasks = (events: EventMsg[]): ChatTask[] | undefined => taskEvents(events).at(-1)?.tasks;

describe('LiveSession tasks', () => {
  it('folds SDK task messages into chat.tasks events, without chat items for them', async () => {
    const { adapter, timers, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    await settle();
    const itemsBefore = itemsOf(events).length;
    fake.emit(
      started('a1', {
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: 'Look around',
        tool_use_id: 'toolu_1',
      }),
    );
    fake.emit(progress('a1', { usage: { total_tokens: 7, tool_uses: 1, duration_ms: 5 } }));
    fake.emit(level([]));
    await settle();
    timers.advance(33);
    expect(itemsOf(events)).toHaveLength(itemsBefore);
    expect(lastTasks(events)).toEqual([
      expect.objectContaining({
        taskId: 'a1',
        kind: 'agent',
        subagentType: 'Explore',
        status: 'running',
        tokens: 7,
        toolUses: 1,
        toolUseId: 'toolu_1',
        startedAt: expect.any(Number),
      }),
    ]);
    expect(taskEvents(events).every((e) => e.sessionId === s.sessionId)).toBe(true);
    expect(s.tasks()).toEqual(lastTasks(events));
  });

  it('coalesces task changes into at most one chat.tasks emit per 33 ms', async () => {
    const { adapter, timers, events, opts } = setup();
    const times: number[] = [];
    LiveSession.create(
      '/p',
      { text: 'go' },
      {
        ...opts,
        emit: (e) => {
          events.push(e);
          if (e.event === 'chat.tasks') times.push(timers.now());
        },
      },
    );
    const fake = adapter.lastSession();
    await settle();
    timers.advance(100);
    fake.emit(started('a1', { task_type: 'local_agent' }));
    for (let i = 1; i <= 50; i++) {
      fake.emit(progress('a1', { usage: { total_tokens: i, tool_uses: i, duration_ms: i } }));
    }
    await settle();
    // A burst in one tick: one leading emit at most, the rest wait for the window.
    expect(times.length).toBeLessThanOrEqual(1);
    timers.advance(33);
    expect(lastTasks(events)?.[0]).toMatchObject({ tokens: 50 });
    // Steady trickle: one change every 5 ms for 300 ms.
    for (let i = 51; i <= 110; i++) {
      fake.emit(progress('a1', { usage: { total_tokens: i, tool_uses: i, duration_ms: i } }));
      await settle();
      timers.advance(5);
    }
    timers.advance(33);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(33);
    }
    expect(times.length).toBeLessThanOrEqual(2 + Math.ceil((300 + 33) / 33));
    expect(lastTasks(events)?.[0]).toMatchObject({ tokens: 110 });
  });

  it('chat.tasks events share the session seq: since() replays them and snapshot() lists the tasks', async () => {
    const { adapter, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(init(s.sessionId));
    fake.emit(started('b1', { task_type: 'local_bash', description: 'npm run dev' }));
    fake.emit(assistantText('a1', 'started the server'));
    fake.emit(result('r1'));
    await settle();
    // Buffered (coalesced) task changes are flushed by snapshot and since.
    fake.emit(progress('b1', { description: 'npm run dev (port 5173)' }));
    await settle();
    const snap = s.snapshot(10);
    expect(snap.tasks).toEqual([
      expect.objectContaining({
        taskId: 'b1',
        kind: 'shell',
        description: 'npm run dev (port 5173)',
      }),
    ]);
    const emitted = chatEvents(events);
    expect(emitted.map(seqOf)).toEqual(Array.from({ length: emitted.length }, (_, i) => i + 1));
    expect(snap.seq).toBe(emitted.length);
    const replay = s.since(0);
    expect(replay).toEqual(emitted);
    expect(replay !== 'gap' && replay.some((e) => e.event === 'chat.tasks')).toBe(true);
    expect(lastTasks(events)).toEqual(snap.tasks);
  });

  it('skips a chat.tasks emit when nothing visible changed', async () => {
    const { adapter, timers, events, opts } = setup();
    LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(started('b1', { task_type: 'local_bash' }));
    await settle();
    timers.advance(100);
    const n = taskEvents(events).length;
    fake.emit(level([{ task_id: 'b1', task_type: 'local_bash', description: 'task b1' }]));
    await settle();
    timers.advance(100);
    expect(taskEvents(events).length).toBe(n + 1); // now backgrounded
    fake.emit(level([{ task_id: 'b1', task_type: 'local_bash', description: 'task b1' }]));
    await settle();
    timers.advance(100);
    expect(taskEvents(events).length).toBe(n + 1);
  });

  it('stopTask asks the SDK to stop the task; the stopped notification updates it', async () => {
    const { adapter, timers, events, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(started('b1', { task_type: 'local_bash', is_backgrounded: true }));
    await settle();
    await s.stopTask('b1');
    expect(fake.stoppedTasks).toEqual(['b1']);
    fake.emit(notification('b1', 'stopped'));
    await settle();
    timers.advance(33);
    expect(lastTasks(events)?.[0]).toMatchObject({
      status: 'stopped',
      endedAt: expect.any(Number),
    });
    // Stopping a task that already ended is a no-op.
    await s.stopTask('b1');
    expect(fake.stoppedTasks).toEqual(['b1']);
  });

  it('stopTask errors: UNKNOWN_TASK, STOP_FAILED, NOT_LIVE', async () => {
    const { adapter, opts } = setup();
    const s = LiveSession.create('/p', { text: 'go' }, opts);
    const fake = adapter.lastSession();
    fake.emit(started('b1', { task_type: 'local_bash' }));
    await settle();
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: unknown) => (e instanceof ServiceError ? e.code : String(e)),
      );
    expect(await codeOf(s.stopTask('nope'))).toBe('UNKNOWN_TASK');
    fake.stopTaskError = new Error('Task b1 is not running');
    expect(await codeOf(s.stopTask('b1'))).toBe('STOP_FAILED');
    s.end();
    expect(await codeOf(s.stopTask('b1'))).toBe('NOT_LIVE');
  });

  it('forgets the tasks when the process ends (ended, paused or crashed)', async () => {
    for (const how of ['end', 'pause', 'crash'] as const) {
      const { adapter, events, opts } = setup();
      const s = LiveSession.create('/p', { text: 'go' }, opts);
      const fake = adapter.lastSession();
      fake.emit(started('b1', { task_type: 'local_bash' }));
      await settle();
      expect(s.tasks()).toHaveLength(1);
      if (how === 'end') s.end();
      else if (how === 'pause') s.pause();
      else fake.end(new Error('boom'));
      await s.whenEnded();
      await settle();
      expect(s.tasks(), how).toEqual([]);
      expect(lastTasks(events), how).toEqual([]);
      expect(s.snapshot(0).tasks, how).toEqual([]);
    }
  });
});

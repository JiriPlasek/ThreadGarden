/**
 * Messages sent while Claude works (verified against Claude Code 2.1.319, see
 * docs/architecture.md "Messages sent while Claude works"): Claude Code takes
 * such a message up at the running turn's next step, or when the turn ends,
 * and says so with a `command_lifecycle` frame. Until then the message is
 * listed as queued, outside the transcript; then it joins the transcript
 * where Claude read it.
 */
import { describe, expect, it } from 'vitest';
import type { ChatItem, EventMsg, QueuedMessage } from '@threadgarden/protocol';
import {
  ITEMS_COALESCE_MS,
  LiveSession,
  type LiveSessionOptions,
} from '../../src/chat/live-session.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import {
  ManualTimers,
  MemoryRegistry,
  assistantText,
  lifecycle,
  result,
  sdk,
  settle,
  statuses,
} from './live-helpers.js';

const setup = (over: Partial<LiveSessionOptions> = {}) => {
  const adapter = new FakeAdapter();
  const timers = new ManualTimers();
  const events: EventMsg[] = [];
  const turns: number[] = [];
  const errors: string[] = [];
  const opts: LiveSessionOptions = {
    adapter,
    registry: new MemoryRegistry(),
    claudePath: '/bin/claude',
    env: {},
    emit: (e) => events.push(e),
    now: timers.now,
    timers,
    onTurnEnded: (_id, at) => turns.push(at),
    onError: (_err, context) => errors.push(context),
    ...over,
  };
  const s = LiveSession.create('/p', { text: 'first' }, opts);
  const fake = adapter.lastSession();
  const firstUuid = fake.sent[0]!.uuid!;
  return { adapter, timers, events, turns, errors, opts, s, fake, firstUuid };
};

/** Every item the session published, latest version per id, in first-seen order. */
const transcript = (events: EventMsg[]): ChatItem[] => {
  const byId = new Map<string, ChatItem>();
  for (const e of events) {
    if (e.event !== 'chat.items') continue;
    for (const item of (e.data as { items: ChatItem[] }).items) byId.set(item.id, item);
  }
  return [...byId.values()];
};

const ids = (events: EventMsg[]): string[] => transcript(events).map((i) => i.id);

/** The queue as the latest `chat.status` event published it. */
const lastQueued = (events: EventMsg[]): QueuedMessage[] | undefined =>
  (
    events.filter((e) => e.event === 'chat.status').at(-1)?.data as {
      queued?: QueuedMessage[];
    }
  )?.queued;

const finished = (events: EventMsg[]) => events.filter((e) => e.event === 'chatFinished');

describe('messages sent while Claude works', () => {
  it('every message goes out with priority next, so Claude never holds one until the turn ends', async () => {
    const { s, fake, firstUuid } = setup();
    // The first message of a new chat, a follow-up while working, and one while idle.
    expect(fake.sent[0]!.priority).toBe('next');
    s.send({ text: 'second' });
    expect(fake.sent[1]!.priority).toBe('next');
    fake.emit(lifecycle(firstUuid, 'started'));
    fake.emit(lifecycle(fake.sent[1]!.uuid!, 'started'));
    fake.emit(result('r1'));
    await settle();
    expect(s.status).toBe('idle');
    expect(s.send({ text: 'third' })).toEqual({ queued: false });
    expect(fake.sent[2]!.priority).toBe('next');
  });

  it('a follow-up is listed as queued, not in the transcript, until Claude reads it', async () => {
    const { s, fake, events, timers, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    fake.emit(assistantText('a1', 'Looking at the files'));
    await settle();

    timers.advance(1000);
    expect(s.send({ text: 'also check the docs' })).toEqual({ queued: true });
    const uuid = fake.sent[1]!.uuid!;
    expect(ids(events)).toEqual([firstUuid, 'a1']);
    const queued = [{ id: uuid, text: 'also check the docs', ts: timers.now() }];
    expect(lastQueued(events)).toEqual(queued);
    expect(s.snapshot(10).queued).toEqual(queued);

    // Claude takes it up at the turn's next step: it joins the transcript there.
    fake.emit(assistantText('a2', 'Still looking'));
    fake.emit(lifecycle(uuid, 'queued'));
    fake.emit(lifecycle(uuid, 'started'));
    fake.emit(assistantText('a3', 'Checking the docs too'));
    await settle();
    timers.advance(ITEMS_COALESCE_MS);
    expect(ids(events)).toEqual([firstUuid, 'a1', 'a2', uuid, 'a3']);
    expect(transcript(events).find((i) => i.id === uuid)).toMatchObject({
      kind: 'user',
      text: 'also check the docs',
    });
    expect(lastQueued(events)).toEqual([]);
    expect(s.snapshot(10).queued).toEqual([]);
  });

  it('a queued message is listed with how many images it has; they join with it', async () => {
    const { s, fake, events, timers, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: '', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] });
    const uuid = fake.sent[1]!.uuid!;
    // Not the image data: every status event carries the list to every client.
    expect(lastQueued(events)).toEqual([
      { id: uuid, text: '', imageCount: 1, ts: expect.any(Number) },
    ]);
    fake.emit(lifecycle(uuid, 'started'));
    await settle();
    timers.advance(ITEMS_COALESCE_MS);
    expect(transcript(events).find((i) => i.id === uuid)).toMatchObject({
      kind: 'user',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
  });

  it('a follow-up Claude read mid-turn does not keep the turn from finishing', async () => {
    const { s, fake, events, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'second' });
    const uuid = fake.sent[1]!.uuid!;
    fake.emit(lifecycle(uuid, 'started'));
    fake.emit(assistantText('a1', 'Done, and the second thing too'));
    fake.emit(lifecycle(uuid, 'completed'));
    fake.emit(result('r1'));
    fake.emit(lifecycle(firstUuid, 'completed'));
    await settle();
    expect(s.status).toBe('idle');
    expect(turns).toHaveLength(1);
    expect(finished(events)).toHaveLength(1);
  });

  it('a follow-up still waiting at the result keeps the chat working; its own turn ends it', async () => {
    const { s, fake, events, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'second' });
    const uuid = fake.sent[1]!.uuid!;
    fake.emit(lifecycle(uuid, 'queued'));
    fake.emit(assistantText('a1', 'First answer'));
    fake.emit(result('r1'));
    await settle();
    // Claude goes straight on to "second": not idle, not finished.
    expect(s.status).toBe('working');
    expect(statuses(events)).not.toContain('idle');
    expect(turns).toEqual([]);
    expect(lastQueued(events)).toHaveLength(1);

    fake.emit(lifecycle(firstUuid, 'completed'));
    fake.emit(lifecycle(uuid, 'started'));
    fake.emit(assistantText('a2', 'Second answer'));
    fake.emit(result('r2'));
    await settle();
    expect(ids(events)).toEqual([firstUuid, 'a1', 'r1', uuid, 'a2', 'r2']);
    expect(s.status).toBe('idle');
    expect(turns).toHaveLength(1);
    expect(finished(events)).toHaveLength(1);
  });

  it('a queued message that runs without a result of its own still lets the chat go idle', async () => {
    const { s, fake, events, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: '/effort low' });
    s.send({ text: 'and then this' });
    const [effort, then] = [fake.sent[1]!.uuid!, fake.sent[2]!.uuid!];
    fake.emit(result('r1'));
    fake.emit(lifecycle(firstUuid, 'completed'));
    // Claude Code 2.1.319 answers a slash command with a result too; one that did not
    // must not leave the chat working forever.
    fake.emit(lifecycle(effort, 'started'));
    fake.emit(lifecycle(effort, 'completed'));
    await settle();
    expect(s.status).toBe('working'); // "and then this" still waits
    fake.emit(lifecycle(then, 'started'));
    fake.emit(lifecycle(then, 'completed'));
    await settle();
    expect(s.status).toBe('idle');
    expect(turns).toHaveLength(1);
    expect(finished(events)).toHaveLength(1);
  });

  it('a message read mid-way through the next turn does not end that turn early', async () => {
    const { s, fake, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'second' });
    const second = fake.sent[1]!.uuid!;
    fake.emit(result('r1'));
    fake.emit(lifecycle(second, 'started'));
    s.send({ text: 'third' });
    const third = fake.sent[2]!.uuid!;
    fake.emit(lifecycle(third, 'started')); // folded into the turn answering "second"
    fake.emit(lifecycle(third, 'completed'));
    await settle();
    expect(s.status).toBe('working');
    expect(turns).toEqual([]);
    fake.emit(result('r2'));
    fake.emit(lifecycle(second, 'completed'));
    await settle();
    expect(s.status).toBe('idle');
    expect(turns).toHaveLength(1);
  });

  it('a message the result or a status frame lists as read is taken up without a lifecycle frame', async () => {
    const { s, fake, events, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'second' });
    s.send({ text: 'third' });
    const [second, third] = [fake.sent[1]!.uuid!, fake.sent[2]!.uuid!];
    fake.emit(
      sdk({
        type: 'system',
        subtype: 'status',
        status: 'requesting',
        user_message_uuids: [firstUuid, second],
        uuid: 'st1',
        session_id: 's',
      }),
    );
    await settle();
    expect(lastQueued(events)?.map((q) => q.id)).toEqual([third]);
    fake.emit(result('r1', { user_message_uuids: [firstUuid, second, third] }));
    await settle();
    expect(lastQueued(events)).toEqual([]);
    expect(ids(events)).toEqual([firstUuid, second, third, 'r1']);
    expect(s.status).toBe('idle');
    expect(turns).toHaveLength(1);
  });

  it('with a Claude Code that sends no lifecycle frames, queued messages join at the result (R28)', async () => {
    const { s, fake, events, turns } = setup();
    s.send({ text: 'second' });
    const uuid = fake.sent[1]!.uuid!;
    fake.emit(assistantText('a1', 'First answer'));
    fake.emit(result('r1'));
    await settle();
    // As before: Claude goes straight on to the queued input, so this is no finished turn.
    expect(turns).toEqual([]);
    expect(ids(events)).toEqual([fake.sent[0]!.uuid, 'a1', 'r1', uuid]);
    expect(lastQueued(events)).toEqual([]);
    fake.emit(assistantText('a2', 'Second answer'));
    fake.emit(result('r2'));
    await settle();
    expect(turns).toHaveLength(1);
  });

  it('a queued message Claude Code cancels leaves the queue with a note', async () => {
    const { s, fake, events, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'never mind' });
    const uuid = fake.sent[1]!.uuid!;
    fake.emit(lifecycle(uuid, 'cancelled'));
    await settle();
    expect(lastQueued(events)).toEqual([]);
    const last = transcript(events).at(-1);
    expect(last).toMatchObject({ kind: 'system', level: 'warning' });
    expect((last as { text: string }).text).toContain('never mind');
  });

  it('a stopped turn with a queued message is not finished; the message still runs next', async () => {
    const { s, fake, events, turns, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'second' });
    await s.interrupt();
    fake.emit(result('r1', { subtype: 'error_during_execution', is_error: true }));
    await settle();
    expect(turns).toEqual([]);
    expect(lastQueued(events)).toHaveLength(1);
    fake.emit(lifecycle(fake.sent[1]!.uuid!, 'started'));
    fake.emit(result('r2'));
    await settle();
    expect(turns).toHaveLength(1);
  });

  it('messages Claude never read are noted when the process ends', async () => {
    const { s, events, firstUuid, fake } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    s.send({ text: 'one more thing' });
    s.end();
    expect(lastQueued(events)).toEqual([]);
    const last = transcript(events).at(-1);
    expect(last).toMatchObject({ kind: 'system', level: 'warning' });
    expect((last as { text: string }).text).toContain('one more thing');

    // A crash notes them too.
    const crashed = setup();
    crashed.fake.emit(lifecycle(crashed.firstUuid, 'started'));
    crashed.s.send({ text: 'are you there?' });
    crashed.fake.end(new Error('boom'));
    await settle();
    expect(lastQueued(crashed.events)).toEqual([]);
    const texts = transcript(crashed.events).map((i) => (i as { text?: string }).text ?? '');
    expect(texts.some((t) => t.includes('are you there?'))).toBe(true);
  });

  it('replays the queue through chat.since like any status change', async () => {
    const { s, fake, firstUuid } = setup();
    fake.emit(lifecycle(firstUuid, 'started'));
    await settle();
    const seq = s.seq;
    s.send({ text: 'second' });
    const events = s.since(seq);
    if (events === 'gap') throw new Error('gap');
    const status = events.filter((e) => e.event === 'chat.status').at(-1);
    expect((status?.data as { queued?: unknown[] }).queued).toHaveLength(1);
  });
});

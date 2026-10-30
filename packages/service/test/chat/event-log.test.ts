import { describe, expect, it } from 'vitest';
import { EventLog, type ChatEventDraft } from '../../src/chat/event-log.js';

const status = (i: number): ChatEventDraft => ({
  event: 'chat.status',
  data: { sessionId: 's', status: i % 2 === 0 ? 'working' : 'idle' },
});

describe('EventLog', () => {
  it('stamps monotonically increasing seq numbers starting at 1', () => {
    const log = new EventLog();
    expect(log.seq).toBe(0);
    expect(log.append(status(0))).toBe(1);
    expect(log.append(status(1))).toBe(2);
    expect(log.seq).toBe(2);
    expect(log.since(0)).toEqual([
      { event: 'chat.status', data: { sessionId: 's', status: 'working', seq: 1 } },
      { event: 'chat.status', data: { sessionId: 's', status: 'idle', seq: 2 } },
    ]);
  });

  it('replays events after seq without gaps or duplicates', () => {
    const log = new EventLog(100);
    for (let i = 0; i < 250; i++) log.append(status(i));
    const after = log.since(200);
    expect(after).not.toBe('gap');
    const seqs = (after as { data: { seq: number } }[]).map((e) => e.data.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => 201 + i));
    expect(log.since(250)).toEqual([]);
    // The oldest retained event is 151, so "everything after 150" is still complete.
    expect((log.since(150) as unknown[]).length).toBe(100);
  });

  it('since returns gap when seq older than buffer', () => {
    const log = new EventLog(5_000);
    for (let i = 0; i < 5_001; i++) log.append(status(i));
    expect(log.since(0)).toBe('gap'); // event 1 was evicted
    expect((log.since(1) as unknown[]).length).toBe(5_000);
  });

  it('defaults to a 5,000-event buffer', () => {
    const log = new EventLog();
    for (let i = 0; i < 5_002; i++) log.append(status(i));
    expect(log.since(1)).toBe('gap');
    expect((log.since(2) as unknown[]).length).toBe(5_000);
  });

  it('returns gap for a seq from the future (e.g. a log from an earlier service run)', () => {
    const log = new EventLog();
    log.append(status(0));
    expect(log.since(7)).toBe('gap');
  });

  it('continues numbering when appending to a carried-over log', () => {
    const log = new EventLog();
    log.append(status(0));
    log.append({
      event: 'chat.items',
      data: { sessionId: 's', items: [], seq: 99 },
    });
    expect(log.since(1)).toEqual([
      { event: 'chat.items', data: { sessionId: 's', items: [], seq: 2 } },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@threadgarden/protocol';
import { timelineActivity } from '../../src/chat/timeline-activity.js';

const T = Date.parse('2026-11-20T09:00:00Z');
const M = 60000;
describe('timeline activity', () => {
  it('uses an explicitly reported reasoning interval when both endpoints are known', () => {
    const item: ChatItem = { kind: 'thinking', id: 'reason', text: 'Reasoning' };
    const a = timelineActivity(
      [item],
      new Map([
        [
          'reason',
          {
            firstAt: T + 120 * M,
            lastAt: T + 120 * M,
            sourceId: 'reason',
            knownInterval: { from: T, to: T + 120 * M },
          },
        ],
      ]),
      T,
      T + 120 * M,
    )!;
    expect(a.bins).toBe('2'.repeat(120));
  });
  it('shows a two-hour pending tool without classifying silent gaps as thinking or API waits', () => {
    const items: ChatItem[] = [
      {
        kind: 'toolCall',
        id: 'bash',
        toolUseId: 'bash',
        name: 'Bash',
        input: {},
        status: 'ok',
        parentToolUseId: null,
        startedAt: T + M,
        endedAt: T + 121 * M,
      },
    ];
    const a = timelineActivity(items, new Map(), T, T + 123 * M)!;
    expect(a.bins[0]).toBe('0');
    expect(a.bins.slice(1, 121)).toBe('1'.repeat(120));
    expect(a.bins.slice(121)).toBe('00');
    expect(a.longestTool).toEqual({ name: 'Bash', durationMs: 120 * M });
    expect(a.reasoning).toBe(0);
  });
  it('keeps reasoning observations and user/assistant exchanges in separate channels', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u', text: 'Follow up', ts: T },
      { kind: 'thinking', id: 'r', text: 'Reasoning' },
      { kind: 'assistantText', id: 'a', markdown: 'Reply', streaming: false },
    ];
    const times = new Map([
      ['r', { firstAt: T + M, lastAt: T + M, sourceId: 'r' }],
      ['a', { firstAt: T + 2 * M, lastAt: T + 2 * M, sourceId: 'reply' }],
    ]);
    const a = timelineActivity(items, times, T, T + 4 * M)!;
    expect(a.bins).toBe('4280');
    expect(a.prompts).toBe(1);
    expect(a.replies).toBe(1);
    expect(a.reasoning).toBe(1);
  });
  it('bounds the payload, merges overlapping states, and does not invent missing dates', () => {
    const items: ChatItem[] = [{ kind: 'thinking', id: 'r', text: 'Reasoning' }];
    expect(timelineActivity(items, new Map(), T, T + M)).toBeUndefined();
    const times = new Map([['r', { firstAt: T, lastAt: T, sourceId: 'r' }]]);
    const a = timelineActivity(items, times, T, T + 14 * 1440 * M)!;
    expect(a.bins.length).toBeLessThanOrEqual(1440);
    expect(a.binMs).toBeGreaterThanOrEqual(M);
    expect(a.bins[0]).toBe('2');
  });
  it('does not stretch an unfinished historical tool to the time the history was opened', () => {
    const items: ChatItem[] = [
      {
        kind: 'toolCall',
        id: 'tool',
        toolUseId: 'tool',
        name: 'Bash',
        input: {},
        parentToolUseId: null,
        status: 'running',
        startedAt: T,
      },
    ];
    const historical = timelineActivity(items, new Map(), T, undefined)!;
    expect(historical.endedAt).toBe(T);
    expect(historical.longestTool).toBeUndefined();
    const live = timelineActivity(items, new Map(), T, undefined, T + 120 * M)!;
    expect(live.longestTool?.durationMs).toBe(120 * M);
  });
  it('does not turn a pause between two streamed chunks into continuous generation', () => {
    const item: ChatItem = {
      kind: 'assistantText',
      id: 'stream',
      markdown: 'Reply',
      streaming: false,
    };
    const a = timelineActivity(
      [item],
      new Map([
        [
          'stream',
          {
            firstAt: T,
            lastAt: T + 120 * M,
            sourceId: 'stream',
            minutes: new Set([T, T + 120 * M]),
          },
        ],
      ]),
      T,
      T + 121 * M,
    )!;
    expect(a.bins).toBe('8' + '0'.repeat(119) + '8');
  });
});

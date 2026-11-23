import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '@threadgarden/protocol';
import { layoutTimeline } from '../../src/lib/components/chat/timeline-layout';

const M = 60000;
const block = (
  id: string,
  start: number,
  end: number,
  kind: 'turn' | 'agent' = 'turn',
): TimelineBlock => ({
  id,
  kind,
  startedAt: start,
  endedAt: end,
  title: id,
  outcome: '',
  status: 'completed',
  toolCount: 0,
  agentCount: 0,
});
describe('timeline layout', () => {
  it('folds overnight idle time but preserves elapsed height while work is running', () => {
    const l = layoutTimeline(
      [block('first', M, 11 * M), block('next', 1440 * M, 1450 * M)],
      1500 * M,
    );
    expect(l.gaps).toHaveLength(1);
    expect(l.placed.map((b) => b.height)).toEqual([20, 20]);
    expect(l.height).toBeLessThan(200);
  });
  it('does not fold a gap covered by a long-running agent', () => {
    const l = layoutTimeline(
      [
        block('one', M, 11 * M),
        block('agent', M, 1445 * M, 'agent'),
        block('two', 1440 * M, 1450 * M),
      ],
      1500 * M,
    );
    expect(l.gaps).toHaveLength(0);
  });
  it('places overlapping agents in separate lanes and reuses the first free lane', () => {
    const l = layoutTimeline(
      [
        block('one', M, 10 * M, 'agent'),
        block('two', 2 * M, 8 * M, 'agent'),
        block('three', 10 * M, 11 * M, 'agent'),
      ],
      15 * M,
    );
    expect(l.placed.map((b) => b.lane)).toEqual([0, 1, 0]);
    expect(l.lanes).toBe(2);
  });
  it('keeps undated blocks out of the time axis and grows live blocks to now', () => {
    const undated = { ...block('unknown', M, 2 * M), startedAt: undefined, endedAt: undefined };
    const live = { ...block('live', M, 2 * M), status: 'running' as const, endedAt: undefined };
    const l = layoutTimeline([undated, live], 11 * M);
    expect(l.undated).toEqual([undated]);
    expect(l.placed[0]?.height).toBe(20);
    expect(l.nowY).toBeDefined();
  });
  it('hatches the wait between completed turns without counting it as work', () => {
    const l = layoutTimeline([block('one', M, 5 * M), block('two', 15 * M, 20 * M)], 30 * M);
    expect(l.waits).toEqual([{ y: 36, height: 20, duration: 10 * M }]);
    expect(l.gaps).toHaveLength(0);
  });
});

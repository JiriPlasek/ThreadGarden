import { describe, expect, it } from 'vitest';
import type { TimelineActivity } from '@threadgarden/protocol';
import { activityRuns, activitySummary } from '../../src/lib/components/chat/timeline-activity';

const activity: TimelineActivity = {
  startedAt: 60000,
  endedAt: 60000 * 7,
  binMs: 60000,
  bins: '0011c2',
  prompts: 3,
  replies: 4,
  reasoning: 7,
  toolCalls: 1,
  longestTool: { name: 'Bash', durationMs: 120 * 60000 },
};
describe('activity strip data', () => {
  it('groups adjacent buckets without creating per-minute DOM elements', () => {
    expect(activityRuns(activity)).toEqual([
      { from: 180000, to: 300000, mask: 1 },
      { from: 300000, to: 360000, mask: 12 },
      { from: 360000, to: 420000, mask: 2 },
    ]);
  });
  it('explains observations without claiming reasoning or API wait durations', () => {
    expect(activitySummary(activity)).toContain('3 prompts');
    expect(activitySummary(activity)).toContain('Bash, 2h 00m');
    expect(activitySummary(activity)).toContain('7 reasoning observations');
    expect(activitySummary(activity)).toContain('not assumed to be API waits');
  });
});

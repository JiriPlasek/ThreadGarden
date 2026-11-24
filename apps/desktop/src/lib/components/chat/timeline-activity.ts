import type { TimelineActivity } from '@threadgarden/protocol';
import { elapsed } from './format';

export const ACTIVITY_COLORS = ['#38bdf8', '#c084fc', '#4ade80', '#2dd4bf'] as const;

export const activitySummary = (a: TimelineActivity): string => {
  const resolution = Math.round(a.binMs / 60000);
  return (
    `${a.prompts} prompts · ${a.replies} responses · ${a.reasoning} reasoning observations · ${a.toolCalls} tools` +
    (a.longestTool
      ? ` · Longest tool interval: ${a.longestTool.name}, ${elapsed(a.longestTool.durationMs)}`
      : '') +
    ` · ${resolution} min samples. Tool intervals run from call to result and can include execution, approval or other waits. Reasoning/message spans use reported timings; other marks are observations. Unclassified gaps are not assumed to be API waits.`
  );
};

/** Run-length grouping keeps canvas drawing cheap even on a multi-day block. */
export const activityRuns = (a: TimelineActivity) => {
  const runs: { from: number; to: number; mask: number }[] = [];
  for (let i = 0; i < a.bins.length;) {
    const mask = Number.parseInt(a.bins[i]!, 16);
    let end = i + 1;
    while (end < a.bins.length && a.bins[end] === a.bins[i]) end++;
    if (mask)
      runs.push({
        from: a.startedAt + i * a.binMs,
        to: Math.min(a.endedAt, a.startedAt + end * a.binMs),
        mask,
      });
    i = end;
  }
  return runs;
};

import type { TimelineBlock } from '@threadgarden/protocol';

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;
export type PlacedBlock = { block: TimelineBlock; y: number; height: number; lane: number };

/** Fold only gaps where no known work ran. Overlapping agents keep the axis continuous. */
export const layoutTimeline = (blocks: readonly TimelineBlock[], now: number, scale = 2) => {
  const timed = blocks
    .flatMap((block) => {
      const start = block.startedAt ?? block.endedAt;
      if (start === undefined) return [];
      const end = Math.max(start, block.endedAt ?? (block.status === 'running' ? now : start));
      return [{ block, start, end }];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: { start: number; end: number }[] = [];
  for (const t of timed) {
    const previous = spans.at(-1);
    if (previous && t.start - previous.end <= IDLE) previous.end = Math.max(previous.end, t.end);
    else spans.push({ start: t.start, end: t.end });
  }
  const gaps: { start: number; end: number; y: number }[] = [];
  const ticks: { at: number; y: number }[] = [];
  const segments: { start: number; end: number; y: number }[] = [];
  let height = 28;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const previous = spans[i - 1];
    if (previous) {
      gaps.push({ start: previous.end, end: span.start, y: height });
      height += 36;
    }
    segments.push({ ...span, y: height });
    const tickStep = Math.max(1, Math.ceil(64 / scale)) * MINUTE;
    ticks.push({ at: span.start, y: height });
    for (let at = span.start + tickStep; at <= span.end; at += tickStep) {
      ticks.push({ at, y: height + ((at - span.start) / MINUTE) * scale });
    }
    height += Math.max(8, ((span.end - span.start) / MINUTE) * scale) + 14;
  }
  const yOf = (at: number): number => {
    const s = segments.find((s) => at >= s.start && at <= s.end);
    return s ? s.y + ((at - s.start) / MINUTE) * scale : height;
  };
  const laneEnds: number[] = [];
  const placed: PlacedBlock[] = timed.map(({ block, start, end }) => {
    let lane = -1;
    if (block.kind === 'agent') {
      lane = laneEnds.findIndex((last) => last <= start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = end;
    }
    return { block, y: yOf(start), height: Math.max(4, ((end - start) / MINUTE) * scale), lane };
  });
  const turns = timed.filter((t) => t.block.kind === 'turn');
  const waits = turns.flatMap((turn, i) => {
    const next = turns[i + 1];
    if (!next || turn.block.endedAt === undefined || next.start <= turn.end) return [];
    return segments.flatMap((s) => {
      const start = Math.max(turn.end, s.start);
      const end = Math.min(next.start, s.end);
      return end > start
        ? [{ y: yOf(start), height: ((end - start) / MINUTE) * scale, duration: end - start }]
        : [];
    });
  });
  return {
    placed,
    gaps,
    ticks,
    waits,
    height: height + 28,
    lanes: laneEnds.length,
    undated: blocks.filter((b) => b.startedAt === undefined && b.endedAt === undefined),
    nowY: timed.some((b) => b.block.status === 'running') ? yOf(now) : undefined,
  };
};

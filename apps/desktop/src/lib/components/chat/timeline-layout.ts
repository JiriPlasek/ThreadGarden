import type { TimelineBlock } from '@threadgarden/protocol';

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;
const MIN_BLOCK_HEIGHT = 56;
export type PlacedBlock = { block: TimelineBlock; y: number; height: number; lane: number };

const clockStep = (scale: number): number =>
  ([1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].find((m) => m * scale >= 64) ?? 1440) *
  MINUTE;

/** Local clock boundaries, including fractional-hour timezones. */
const floorClock = (at: number, step: number): number => {
  const offset = new Date(at).getTimezoneOffset() * MINUTE;
  return Math.floor((at - offset) / step) * step + offset;
};

/**
 * Fold idle gaps only. Expand short intervals just enough for every label.
 * All lanes share the resulting map; recorded dates/durations never change.
 */
export const layoutTimeline = (blocks: readonly TimelineBlock[], now: number, scale = 2) => {
  const timed = blocks
    .flatMap((block) => {
      const start = block.startedAt ?? block.endedAt;
      if (start === undefined) return [];
      const end = Math.max(start, block.endedAt ?? (block.status === 'running' ? now : start));
      return [{ block, start, end }];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: { start: number; end: number; entries: typeof timed }[] = [];
  for (const entry of timed) {
    const previous = spans.at(-1);
    if (previous && entry.start - previous.end <= IDLE) {
      previous.end = Math.max(previous.end, entry.end);
      previous.entries.push(entry);
    } else spans.push({ start: entry.start, end: entry.end, entries: [entry] });
  }
  const gaps: { start: number; end: number; y: number }[] = [];
  const ticks: { at: number; y: number }[] = [];
  const segments: { start: number; end: number; points: { at: number; y: number }[] }[] = [];
  const step = clockStep(scale);
  let height = 28;
  let expanded = false;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const previous = spans[i - 1];
    if (previous) {
      gaps.push({ start: previous.end, end: span.start, y: height });
      height += 36;
    }
    const axisStart = Math.max(previous?.end ?? -Infinity, floorClock(span.start, step));
    const times = [
      ...new Set([axisStart, span.end, ...span.entries.flatMap((e) => [e.start, e.end])]),
    ].sort((a, b) => a - b);
    const ends = new Map<number, typeof timed>();
    const instants = new Set<number>();
    for (const e of span.entries) {
      if (e.end === e.start) instants.add(e.start);
      else {
        const entries = ends.get(e.end) ?? [];
        entries.push(e);
        ends.set(e.end, entries);
      }
    }
    const points: { at: number; y: number }[] = [];
    const positions = new Map<number, number>();
    for (const at of times) {
      const last = points.at(-1);
      let y = last
        ? last.y +
          Math.max(((at - last.at) / MINUTE) * scale, instants.has(last.at) ? MIN_BLOCK_HEIGHT : 0)
        : height;
      for (const e of ends.get(at) ?? [])
        y = Math.max(y, positions.get(e.start)! + MIN_BLOCK_HEIGHT);
      if (last && y - last.y > ((at - last.at) / MINUTE) * scale + 0.01) expanded = true;
      positions.set(at, y);
      points.push({ at, y });
    }
    const segment = { start: axisStart, end: span.end, points };
    segments.push(segment);
    for (let at = floorClock(axisStart, step); at <= span.end; at += step) {
      if (at >= axisStart) ticks.push({ at, y: interpolate(points, at) });
    }
    const last = points.at(-1)!;
    if (instants.has(last.at)) expanded = true;
    height = last.y + (instants.has(last.at) ? MIN_BLOCK_HEIGHT : 0) + 14;
  }
  const yOf = (at: number): number => {
    const segment = segments.find((s) => at >= s.start && at <= s.end);
    return segment ? interpolate(segment.points, at) : height;
  };
  const laneEnds: number[] = [];
  const placed: PlacedBlock[] = timed.map(({ block, start, end }) => {
    let lane = -1;
    if (block.kind === 'agent') {
      lane = laneEnds.findIndex((last) => last <= start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = Math.max(end, start + 1);
    }
    return {
      block,
      y: yOf(start),
      height: Math.max(MIN_BLOCK_HEIGHT, yOf(end) - yOf(start)),
      lane,
    };
  });
  const turns = timed.filter((t) => t.block.kind === 'turn');
  const waits = turns.flatMap((turn, i) => {
    const next = turns[i + 1];
    if (!next || turn.block.endedAt === undefined || next.start <= turn.end) return [];
    return segments.flatMap((s) => {
      const start = Math.max(turn.end, s.start);
      const end = Math.min(next.start, s.end);
      return end > start
        ? [{ y: yOf(start), height: yOf(end) - yOf(start), duration: end - start }]
        : [];
    });
  });
  return {
    placed,
    gaps,
    ticks,
    waits,
    expanded,
    yOf,
    height: height + 28,
    lanes: laneEnds.length,
    nowY: timed.some((b) => b.block.status === 'running') ? yOf(now) : undefined,
  };
};

/** Piecewise mapping shared by blocks, clock ticks and wait bands. */
const interpolate = (points: readonly { at: number; y: number }[], at: number): number => {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid]!.at <= at) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo]!;
  const b = points[lo + 1];
  return b ? a.y + ((at - a.at) / (b.at - a.at)) * (b.y - a.y) : a.y;
};

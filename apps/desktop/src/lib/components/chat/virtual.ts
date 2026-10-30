/**
 * Geometry for a variable-height virtual list: row offsets from measured (or
 * estimated) heights, the window of rows to render, and a scroll anchor (a row
 * key plus the distance scrolled past its top) that keeps what the user is
 * looking at in place when rows above it change height or are prepended.
 */

export type Anchor = { key: string; delta: number };

/** `offsets[i]` is row i's top; `offsets[n]` the total height. */
export const computeOffsets = (n: number, height: (i: number) => number): Float64Array => {
  const offsets = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i]! + height(i);
  return offsets;
};

/** The row containing `y` (clamped to the rows that exist). */
export const indexAt = (offsets: Float64Array, y: number): number => {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** Rows to render, `[start, end)`, for a viewport at `scrollTop` of `height`. */
export const visibleRange = (
  offsets: Float64Array,
  scrollTop: number,
  height: number,
  overscan: number,
): [number, number] => {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  const first = indexAt(offsets, scrollTop);
  const last = indexAt(offsets, Math.max(scrollTop, scrollTop + height - 1));
  return [Math.max(0, first - overscan), Math.min(n, last + 1 + overscan)];
};

/** The row at the top of the viewport and how far it is scrolled past. */
export const captureAnchor = (
  keys: readonly string[],
  offsets: Float64Array,
  scrollTop: number,
): Anchor | null => {
  if (keys.length === 0) return null;
  const i = indexAt(offsets, scrollTop);
  return { key: keys[i]!, delta: scrollTop - offsets[i]! };
};

/** The scrollTop that puts the anchored row back where it was; null if it is gone. */
export const restoreAnchor = (
  anchor: Anchor,
  indexOf: (key: string) => number,
  offsets: Float64Array,
): number | null => {
  const i = indexOf(anchor.key);
  if (i < 0 || i >= offsets.length - 1) return null;
  return offsets[i]! + anchor.delta;
};

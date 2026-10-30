import { describe, expect, it } from 'vitest';
import {
  captureAnchor,
  computeOffsets,
  indexAt,
  restoreAnchor,
  visibleRange,
} from '../../src/lib/components/chat/virtual';

const keys = (n: number, prefix = 'k') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const lookup = (ks: string[]) => {
  const m = new Map(ks.map((k, i) => [k, i]));
  return (k: string) => m.get(k) ?? -1;
};

describe('variable-height layout', () => {
  it('computes offsets from per-row heights', () => {
    const offsets = computeOffsets(3, (i) => [10, 20, 30][i]!);
    expect([...offsets]).toEqual([0, 10, 30, 60]);
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 29)).toBe(1);
    expect(indexAt(offsets, 30)).toBe(2);
    expect(indexAt(offsets, 1000)).toBe(2);
  });

  it('renders only the rows in view plus overscan', () => {
    const offsets = computeOffsets(5000, () => 40);
    const [start, end] = visibleRange(offsets, 40_000, 600, 4);
    expect(start).toBe(996);
    expect(end).toBe(1019);
  });

  it('keeps the anchored row in place when rows above it are measured', () => {
    const ks = keys(100);
    const before = computeOffsets(100, () => 50);
    const anchor = captureAnchor(ks, before, 2510)!;
    expect(anchor).toEqual({ key: 'k50', delta: 10 });

    // Rows above turn out taller than estimated: the anchored row moves down by 50 * 30 px.
    const after = computeOffsets(100, (i) => (i < 50 ? 80 : 50));
    expect(restoreAnchor(anchor, lookup(ks), after)).toBe(50 * 80 + 10);
  });

  it('keeps the anchored row in place when older rows are prepended', () => {
    const ks = keys(100);
    const anchor = captureAnchor(
      ks,
      computeOffsets(100, () => 50),
      500,
    )!;
    const grown = [...keys(20, 'old'), ...ks];
    const offsets = computeOffsets(grown.length, () => 50);
    expect(restoreAnchor(anchor, lookup(grown), offsets)).toBe(500 + 20 * 50);
  });

  it('gives up when the anchored row is gone', () => {
    const anchor = { key: 'gone', delta: 0 };
    expect(
      restoreAnchor(
        anchor,
        lookup(keys(3)),
        computeOffsets(3, () => 10),
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  compact,
  full,
  hourLabel,
  labelIndices,
  longDay,
  niceTicks,
  shortDay,
} from '../../src/lib/components/analytics/format';

describe('analytics format', () => {
  it('numbers: in full under 10,000, compact above', () => {
    expect(compact(0)).toBe('0');
    expect(compact(1284)).toBe('1,284');
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
    expect(full(1_284_302)).toBe('1,284,302');
  });

  it('days and hours', () => {
    expect(shortDay('2026-10-31')).toBe('Oct 31');
    expect(longDay('2026-10-31')).toBe('Sat, Oct 31, 2026');
    expect(longDay('2026-10-26', true)).toBe('Week of Oct 26, 2026');
    expect(hourLabel(9)).toBe('09:00');
  });

  it('round ticks that reach the maximum', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(9)).toEqual([0, 5, 10]);
    const t = niceTicks(1234);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBeGreaterThanOrEqual(1234);
    expect(t.length).toBeLessThanOrEqual(6);
    const step = t[1]! - t[0]!;
    expect(t.every((x, i) => x === i * step)).toBe(true);
    expect([1, 2, 5].includes(step / 10 ** Math.floor(Math.log10(step)))).toBe(true);
  });

  it('x labels: first and last always, evenly spaced between, never crowded', () => {
    expect(labelIndices(0, 500)).toEqual([]);
    expect(labelIndices(1, 500)).toEqual([0]);
    expect(labelIndices(7, 700)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const ninety = labelIndices(90, 560);
    expect(ninety[0]).toBe(0);
    expect(ninety.at(-1)).toBe(89);
    expect(ninety.length).toBeLessThanOrEqual(10);
    const gaps = ninety.slice(1).map((x, i) => x - ninety[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.max(...gaps) / 2);
  });
});

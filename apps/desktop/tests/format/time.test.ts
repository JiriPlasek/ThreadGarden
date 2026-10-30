import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/lib/format/time';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const s = 1000;
const m = 60 * s;
const h = 60 * m;
const d = 24 * h;

describe('relativeTime', () => {
  it.each([
    [0, 'now'],
    [59 * s, 'now'],
    [60 * s, '1m'],
    [4 * m + 30 * s, '4m'],
    [59 * m, '59m'],
    [h, '1h'],
    [23 * h, '23h'],
    [d, '1d'],
    [6 * d, '6d'],
    [7 * d, '1w'],
    [34 * d, '4w'],
    [35 * d, '1mo'],
    [364 * d, '11mo'],
    [365 * d, '1y'],
    [3 * 365 * d, '3y'],
  ])('%d ms ago → %s', (ago, expected) => {
    expect(relativeTime(NOW - ago, NOW)).toBe(expected);
  });

  it('treats future timestamps (clock skew) as now', () => {
    expect(relativeTime(NOW + 5 * m, NOW)).toBe('now');
  });

  it('treats missing timestamps as empty', () => {
    expect(relativeTime(0, NOW)).toBe('');
    expect(relativeTime(Number.NaN, NOW)).toBe('');
  });
});

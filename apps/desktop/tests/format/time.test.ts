import { describe, expect, it } from 'vitest';
import { finishedAt, relativeTime } from '../../src/lib/format/time';

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

describe('finishedAt', () => {
  /** Local time, so the day boundaries hold in any time zone. */
  const at = (day: number, hour: number, minute: number): number =>
    new Date(2026, 10, day, hour, minute).getTime();
  const now = at(9, 15, 0); // Monday, Nov 9 2026
  /** ICU writes a narrow no-break space before AM/PM. */
  const fmt = (ms: number): string => finishedAt(ms, now, 'en-US').replace(/\s/g, ' ');

  it('today: the time alone', () => {
    expect(fmt(at(9, 6, 4))).toBe('6:04 AM');
    expect(fmt(at(9, 0, 0))).toBe('12:00 AM');
  });

  it('within the week: the weekday and the time', () => {
    expect(fmt(at(8, 23, 0))).toBe('Sunday 11:00 PM');
    expect(fmt(at(3, 4, 30))).toBe('Tuesday 4:30 AM');
  });

  it('a week or more ago: weekday, date and time', () => {
    expect(fmt(at(2, 9, 5))).toBe('Monday, Nov 2, 9:05 AM');
    expect(fmt(at(1, 23, 59))).toBe('Sunday, Nov 1, 11:59 PM');
  });

  it('another year: the year too', () => {
    expect(fmt(new Date(2025, 11, 31, 8, 0).getTime())).toBe('Wednesday, Dec 31, 2025, 8:00 AM');
  });

  it('a missing time is empty; a future one (clock skew) reads as today', () => {
    expect(finishedAt(0, now)).toBe('');
    expect(fmt(at(9, 16, 0))).toBe('4:00 PM');
  });
});

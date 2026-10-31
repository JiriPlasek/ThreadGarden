import { describe, expect, it } from 'vitest';
import {
  formatHoldUntil,
  fromDateTimeLocal,
  holdPresets,
  toDateTimeLocal,
} from '../../src/lib/format/hold';
import { isNow } from '../../src/lib/components/layout/sections';
import { summary } from '../layout/harness';

/**
 * Every expectation is built with the local-time `Date` constructor, like the
 * code under test, so these hold in any time zone (and across DST changes).
 */
const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

describe('hold presets (v1.2 §3)', () => {
  it('Tomorrow is 09:00 local time on the next day', () => {
    expect(holdPresets(local(2026, 10, 31, 15, 20)).tomorrow).toBe(local(2026, 11, 1, 9));
    // Just after midnight, tomorrow is still the next calendar day.
    expect(holdPresets(local(2026, 10, 31, 0, 5)).tomorrow).toBe(local(2026, 11, 1, 9));
    // Month and year ends roll over.
    expect(holdPresets(local(2026, 12, 31, 18)).tomorrow).toBe(local(2027, 1, 1, 9));
  });

  it('Next week is the coming Monday at 09:00 (a Monday gives the one after)', () => {
    // 2026-10-31 is a Saturday.
    expect(new Date(local(2026, 10, 31)).getDay()).toBe(6);
    expect(holdPresets(local(2026, 10, 31, 15)).nextWeek).toBe(local(2026, 11, 2, 9));
    // Sunday → the next day; Monday (even before 09:00) → a week later.
    expect(holdPresets(local(2026, 11, 1, 10)).nextWeek).toBe(local(2026, 11, 2, 9));
    expect(holdPresets(local(2026, 11, 2, 7)).nextWeek).toBe(local(2026, 11, 9, 9));
    expect(holdPresets(local(2026, 11, 6, 23, 59)).nextWeek).toBe(local(2026, 11, 9, 9));
  });

  it('keeps 09:00 local across a daylight-saving change', () => {
    // Whatever the zone, 09:00 of each day is what the presets return.
    for (let d = 20; d <= 31; d++) {
      const t = holdPresets(local(2026, 3, d, 12)).tomorrow;
      expect(new Date(t).getHours()).toBe(9);
      expect(new Date(t).getMinutes()).toBe(0);
    }
  });
});

describe('hold dates in rows and the header', () => {
  const now = local(2026, 10, 31, 15, 20); // Saturday

  it('reads relative to today: today, tomorrow, a weekday, then a date', () => {
    expect(formatHoldUntil(local(2026, 10, 31, 18, 30), now)).toBe('today 18:30');
    expect(formatHoldUntil(local(2026, 11, 1, 9), now)).toBe('tomorrow 09:00');
    expect(formatHoldUntil(local(2026, 11, 2, 9), now)).toBe('Mon 09:00');
    expect(formatHoldUntil(local(2026, 11, 6, 17, 5), now)).toBe('Fri 17:05');
    expect(formatHoldUntil(local(2026, 11, 7, 9), now)).toBe('Nov 7, 09:00');
    expect(formatHoldUntil(local(2027, 2, 3, 9), now)).toBe('Feb 3 2027, 09:00');
  });

  it('a time already past still reads as a date', () => {
    expect(formatHoldUntil(local(2026, 10, 30, 9), now)).toBe('Oct 30, 09:00');
  });
});

describe('the "Pick date & time" field', () => {
  it('round-trips local date-time values', () => {
    const t = local(2026, 11, 3, 14, 5);
    expect(toDateTimeLocal(t)).toBe('2026-11-03T14:05');
    expect(fromDateTimeLocal('2026-11-03T14:05')).toBe(t);
  });

  it('rejects what is not a date and time', () => {
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('2026-11-03')).toBeNull();
    expect(fromDateTimeLocal('soon')).toBeNull();
    expect(fromDateTimeLocal('2026-13-40T25:99')).toBeNull();
  });
});

describe('back from hold in the recency sections', () => {
  it('a chat back from hold keeps its recency section (Ruling R34: the service does not lift it)', () => {
    expect(isNow(summary('a', { backFromHold: true }))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  agoText,
  clockTime,
  percentText,
  resetText,
  sendTimeText,
  spanText,
} from '../../src/lib/format/usage';

// Local time, like the app: 31 Oct 2026, 12:46.
const NOW = new Date(2026, 9, 31, 12, 46).getTime();
const MIN = 60_000;

describe('usage formatting', () => {
  it('clock times and spans', () => {
    expect(clockTime(new Date(2026, 9, 31, 15, 0).getTime())).toBe('15:00');
    expect(spanText(30_000)).toBe('less than a minute');
    expect(spanText(45 * MIN)).toBe('45 min');
    expect(spanText(134 * MIN)).toBe('2 h 14 min');
    expect(spanText(120 * MIN)).toBe('2 h');
    expect(spanText((3 * 24 + 4) * 60 * MIN)).toBe('3 d 4 h');
  });

  it('reset times, relative and absolute', () => {
    expect(resetText(NOW + 134 * MIN, NOW)).toBe('resets in 2 h 14 min, at 15:00');
    expect(resetText(new Date(2026, 10, 2, 9, 0).getTime(), NOW)).toBe(
      'resets in 1 d 20 h, Mon 09:00',
    );
    expect(resetText(NOW - 1, NOW)).toBe('has reset');
  });

  it('observed times, percentages and send times', () => {
    expect(agoText(NOW - 10_000, NOW)).toBe('just now');
    expect(agoText(NOW - 3 * MIN, NOW)).toBe('3 min ago');
    expect(agoText(NOW - 125 * MIN, NOW)).toBe('2 h ago');
    expect(percentText(41.6)).toBe('42%');
    expect(percentText(-3)).toBe('0%');
    expect(sendTimeText(NOW + 134 * MIN, NOW)).toBe('today 15:00');
    expect(sendTimeText(NOW - MIN, NOW)).toBe('now');
  });
});

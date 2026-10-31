/**
 * Dates of "Put on hold" (v1.2 §3). Everything is in local time and built with
 * the local-time `Date` setters, so 09:00 stays 09:00 across daylight-saving
 * changes. The clock is passed in (tests freeze it).
 */

/** The hour the presets end on (local time). */
export const HOLD_HOUR = 9;

const atNine = (base: Date, addDays: number): number => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays);
  d.setHours(HOLD_HOUR, 0, 0, 0);
  return d.getTime();
};

/**
 * "Tomorrow" (09:00 on the next day) and "Next week" (the coming Monday at
 * 09:00; on a Monday, the one after).
 */
export const holdPresets = (now: number): { tomorrow: number; nextWeek: number } => {
  const today = new Date(now);
  const toMonday = (8 - today.getDay()) % 7 || 7;
  return { tomorrow: atNine(today, 1), nextWeek: atNine(today, toMonday) };
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayNumber = (d: Date): number =>
  Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

/**
 * When a hold ends, compactly and relative to `now`: "today 18:30",
 * "tomorrow 09:00", "Mon 09:00" within the coming week, then "Nov 7, 09:00"
 * ("Feb 3 2027, 09:00" in another year).
 */
export const formatHoldUntil = (until: number, now: number): string => {
  const d = new Date(until);
  const n = new Date(now);
  const days = dayNumber(d) - dayNumber(n);
  if (days === 0) return `today ${clock(d)}`;
  if (days === 1) return `tomorrow ${clock(d)}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${clock(d)}`;
  const year = d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${clock(d)}`;
};

/** The value of an `<input type="datetime-local">` for a time: "2026-11-03T14:05". */
export const toDateTimeLocal = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${clock(d)}`;
};

/** A `datetime-local` value as a time, or null when it is not a valid date and time. */
export const fromDateTimeLocal = (value: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  // Out-of-range parts (month 13, 25:99) roll over in Date: refuse them instead.
  if (date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h) return null;
  if (date.getMinutes() !== mi) return null;
  return date.getTime();
};

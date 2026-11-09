const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = DAY * 30.4375;
const YEAR = 365 * DAY;

/**
 * Compact age of a timestamp for dense lists: "now", "4m", "2h", "3d", "2w", "5mo", "1y".
 * Future timestamps (clock skew) read as "now"; a missing timestamp (0, NaN) is "".
 */
export const relativeTime = (ms: number, now: number = Date.now()): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const ago = now - ms;
  if (ago < MINUTE) return 'now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
  if (ago < WEEK) return `${Math.floor(ago / DAY)}d`;
  if (ago < 5 * WEEK) return `${Math.floor(ago / WEEK)}w`;
  if (ago < YEAR) return `${Math.min(11, Math.floor(ago / MONTH))}mo`;
  return `${Math.floor(ago / YEAR)}y`;
};

/**
 * When something finished, the way Claude Code writes it: "6:04 AM" today,
 * "Tuesday 6:04 AM" within the last week, "Tuesday, Nov 3, 6:04 AM" before
 * that (with the year when it is not this one). Days are calendar days in
 * local time; a future time (clock skew) reads as today, a missing one is "".
 */
export const finishedAt = (ms: number, now: number = Date.now(), locale?: string): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const today = new Date(now);
  const dayStart = (t: Date): number =>
    new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(d)) / DAY);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days <= 0) return time;
  if (days < 7) return `${d.toLocaleDateString(locale, { weekday: 'long' })} ${time}`;
  const date = d.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
};

/** Absolute date and time for tooltips. */
export const fullTime = (ms: number): string =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '';

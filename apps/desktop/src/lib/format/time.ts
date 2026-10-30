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

/** Absolute date and time for tooltips. */
export const fullTime = (ms: number): string =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '';

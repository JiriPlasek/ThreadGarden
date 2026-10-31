/**
 * Times and amounts of the usage meter, the Usage dialog and scheduled sends
 * (v1.3 B). Local time; the clock is passed in (tests freeze it).
 */
import { formatHoldUntil } from './hold';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n: number): string => String(n).padStart(2, '0');

/** "15:00" (24-hour local time). */
export const clockTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A span of time, compactly: "less than a minute", "45 min", "2 h 14 min", "3 d 4 h". */
export const spanText = (ms: number): string => {
  if (ms < MINUTE) return 'less than a minute';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h > 0 ? `${d} d ${h} h` : `${d} d`;
};

/**
 * When a usage window resets, relative to `now`: "resets in 2 h 14 min, at
 * 15:00"; a day or more ahead "resets in 3 d 4 h, Mon 09:00"; past it "has
 * reset".
 */
export const resetText = (resetsAt: number, now: number): string => {
  const left = resetsAt - now;
  if (left <= 0) return 'has reset';
  const at = left < DAY ? clockTime(resetsAt) : formatHoldUntil(resetsAt, now);
  return `resets in ${spanText(left)}, ${left < DAY ? 'at ' : ''}${at}`;
};

/** How long ago something was observed: "just now", "3 min ago", "2 h ago", "4 d ago". */
export const agoText = (at: number, now: number): string => {
  const ago = now - at;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  return `${Math.floor(ago / DAY)} d ago`;
};

/** A utilization percentage for display: whole numbers, never below 0. */
export const percentText = (u: number): string => `${Math.max(0, Math.round(u))}%`;

/** When a scheduled send goes out, compactly ("today 15:00", "tomorrow 09:00", …). */
export const sendTimeText = (sendAt: number, now: number): string =>
  sendAt <= now ? 'now' : formatHoldUntil(sendAt, now);

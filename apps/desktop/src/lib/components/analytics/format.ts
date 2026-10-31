/**
 * v1.3 analytics: number, day and axis formatting for the charts. Days come
 * from the service as local calendar days, `YYYY-MM-DD`.
 */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat('en-US');

/** In full under 10,000 (1,284), compact above (12.9K, 4.2M). */
export const compact = (n: number): string =>
  Math.abs(n) < 10_000 ? FULL.format(n) : COMPACT.format(n);

/** Every digit, for tables and tooltips (1,284,302). */
export const full = (n: number): string => FULL.format(n);

/** Local midnight of a `YYYY-MM-DD` day. */
export const dateOf = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const LONG = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Oct 31". */
export const shortDay = (day: string): string => SHORT.format(dateOf(day));
/** "Sat, Oct 31, 2026"; a week bucket reads "Week of Oct 26, 2026". */
export const longDay = (day: string, week = false): string =>
  week
    ? `Week of ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dateOf(day))}`
    : LONG.format(dateOf(day));

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAYS_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** "09:00". */
export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/**
 * Round axis ticks from 0 to at least `max`: about `count` steps of 1, 2 or
 * 5 × a power of ten. The last tick is the axis top.
 */
export const niceTicks = (max: number, count = 4): number[] => {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let t = 0; t < max + step / 2 && ticks.length <= count + 1; t += step) ticks.push(t);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
};

/**
 * Indices of the x-axis labels that fit `width` px at about `minGap` px each:
 * the first, the last, and evenly spaced ones between.
 */
export const labelIndices = (n: number, width: number, minGap = 56): number[] => {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const fit = Math.max(2, Math.floor(width / minGap));
  if (n <= fit) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (fit - 1));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  // The last label replaces a neighbour that would crowd it.
  if (n - 1 - (out.at(-1) ?? 0) < step / 2) out.pop();
  out.push(n - 1);
  return out;
};

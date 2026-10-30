/** Compact token counts: 950, 12.3k, 1.2M. */
export const tokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** US-dollar cost with enough precision for small turns. */
export const usd = (n: number): string => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/** 850 ms, 12.3 s, 4m 05s. */
export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

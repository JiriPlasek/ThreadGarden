const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Compact counts: 950, 4.7K, 565K, 1.2M. */
export const compactNumber = (n: number): string => COMPACT.format(n);

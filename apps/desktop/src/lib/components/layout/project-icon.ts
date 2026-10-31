/**
 * Letter tiles for projects without an icon (v1.3 §5). White text on each
 * colour has a contrast ratio of at least 4.5:1, and the colours are mid-dark
 * enough to stand out on both the light and the dark sidebar.
 */
export const TILE_COLORS = [
  '#2563eb', // blue
  '#0f766e', // teal
  '#15803d', // green
  '#7c3aed', // violet
  '#e11d48', // rose
  '#b45309', // amber
  '#0e7490', // cyan
  '#475569', // slate
] as const;

/** FNV-1a: a stable 32-bit hash, the same in every session and on every machine. */
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** The tile colour of a project: the same project id always gets the same colour. */
export const tileColor = (projectId: string): string =>
  TILE_COLORS[hash(projectId) % TILE_COLORS.length]!;

/**
 * The tile letter: the first letter or digit of the display name, upper-cased.
 * A disambiguated name (`parent/base`) uses its base, the project's own name.
 */
export const tileLetter = (displayName: string): string => {
  const base = displayName.slice(displayName.lastIndexOf('/') + 1) || displayName;
  const ch = Array.from(base).find((c) => /[\p{L}\p{N}]/u.test(c));
  return ch ? ch.toLocaleUpperCase() : '?';
};

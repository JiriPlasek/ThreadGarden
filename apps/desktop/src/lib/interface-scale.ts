/**
 * The interface size preference: a scale on top of the 17 px base root font
 * size (layout.css sets `html { font-size: 106.25% }`). Tailwind sizes are in
 * rem, so text, spacing and icons all follow the root font size.
 */

/** `uiState` key the scale is persisted under. */
export const SCALE_KEY = 'interface.scale';
export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.5;
export const SCALE_STEP = 0.1;
/** The root font size at scale 1, as a percentage of the webview's 16 px default. */
export const BASE_FONT_PERCENT = 106.25;
/** The same, in px (what one rem is at scale 1). */
export const BASE_FONT_PX = 17;

/** Every selectable scale, smallest first (80 %, 90 %, …, 150 %). */
export const SCALES: readonly number[] = Array.from(
  { length: Math.round((SCALE_MAX - SCALE_MIN) / SCALE_STEP) + 1 },
  (_, i) => Math.round((SCALE_MIN + i * SCALE_STEP) * 10) / 10,
);

/** Kept in `localStorage` too, so the next start can apply it before the service answers. */
const CACHE_KEY = 'pahub.interface.scale';

/** Rounds to a 10 % step within [80 %, 150 %]; anything that is not a number is 100 %. */
export const clampScale = (scale: number): number => {
  if (!Number.isFinite(scale)) return 1;
  const stepped = Math.round(scale / SCALE_STEP) * SCALE_STEP;
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped)) * 10) / 10;
};

/** Sets the root font size for `scale` (100 % leaves the stylesheet's base in charge). */
export const applyScale = (scale: number, root: HTMLElement = document.documentElement): void => {
  const s = clampScale(scale);
  if (s === 1) root.style.removeProperty('font-size');
  else root.style.fontSize = `${Math.round(BASE_FONT_PERCENT * s * 1000) / 1000}%`;
};

/** A size given in rem, in whole px at `scale` (fixed-height rows of virtual lists). */
export const rowPx = (rem: number, scale: number): number =>
  Math.round(rem * BASE_FONT_PX * clampScale(scale));

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The scale remembered by this webview (1 when there is none). */
export const readCachedScale = (): number => {
  const raw = storage()?.getItem(CACHE_KEY);
  return raw ? clampScale(Number(raw)) : 1;
};

export const cacheScale = (scale: number): void => {
  try {
    storage()?.setItem(CACHE_KEY, String(clampScale(scale)));
  } catch {
    // Not remembering it locally only costs the first paint at the default size.
  }
};

/** What an interface-size key does: Ctrl/Cmd with =, +, - or 0 (main row or numpad). */
export const scaleKeyAction = (e: KeyboardEvent): 'up' | 'down' | 'reset' | null => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') return 'up';
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return 'down';
  if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return 'reset';
  return null;
};

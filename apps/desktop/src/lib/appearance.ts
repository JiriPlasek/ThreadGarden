import { SettingsSchema, sanitizeFontFamily, type Settings } from '@threadgarden/protocol';

/**
 * The appearance settings (spec v1.3 §6) as attributes and one custom
 * property, next to `data-theme` (src/lib/theme.ts). The stylesheet
 * (src/routes/themes.css) keys the token overrides on them; the defaults
 * have no rules, so they look exactly as Threadgarden did before v1.3.
 */
export type Appearance = Pick<
  Settings,
  'theme' | 'accent' | 'darkStyle' | 'lightStyle' | 'uiFont' | 'codeFont'
>;
const KEYS = ['theme', 'accent', 'darkStyle', 'lightStyle', 'uiFont', 'codeFont'] as const;

/** Tailwind's default `--font-mono`, the fallback behind a custom code font. */
export const DEFAULT_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

/**
 * The `--font-mono` value for a custom code font: each sanitised name in
 * double quotes, then the default stack. Null for the default.
 */
export const codeFontStack = (codeFont: string | null): string | null => {
  const names = codeFont === null ? null : sanitizeFontFamily(codeFont);
  if (names === null) return null;
  return `${names
    .split(', ')
    .map((n) => `"${n}"`)
    .join(', ')}, ${DEFAULT_MONO_STACK}`;
};

/** The data attributes for these settings (`data-theme` aside, see theme.ts). */
export const appearanceAttributes = (
  a: Omit<Appearance, 'theme' | 'codeFont'>,
): Record<string, string> => ({
  'data-accent': a.accent,
  'data-dark-style': a.darkStyle,
  'data-light-style': a.lightStyle,
  'data-ui-font': a.uiFont,
});

/** Sets the attributes and the code font on `root` (live, no reload). */
export const applyAppearance = (
  a: Omit<Appearance, 'theme'>,
  root: HTMLElement = document.documentElement,
): void => {
  for (const [k, v] of Object.entries(appearanceAttributes(a))) root.setAttribute(k, v);
  const mono = codeFontStack(a.codeFont);
  if (mono === null) root.style.removeProperty('--font-mono');
  else root.style.setProperty('--font-mono', mono);
};

/**
 * Kept in `localStorage` too, so the next start paints with it before the
 * service answers: app.html applies it before the stylesheet's first paint
 * and SettingsState starts from it.
 */
export const APPEARANCE_CACHE_KEY = 'threadgarden.appearance';

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The appearance this webview remembers; each field checked on its own, invalid ones dropped. */
export const readCachedAppearance = (): Partial<Appearance> => {
  let raw: unknown;
  try {
    raw = JSON.parse(storage()?.getItem(APPEARANCE_CACHE_KEY) ?? 'null');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Appearance> = {};
  for (const key of KEYS) {
    if (!(key in raw)) continue;
    const parsed = SettingsSchema.shape[key].safeParse((raw as Record<string, unknown>)[key]);
    if (parsed.success) Object.assign(out, { [key]: parsed.data });
  }
  return out;
};

export const cacheAppearance = (s: Appearance): void => {
  const value: Appearance = {
    theme: s.theme,
    accent: s.accent,
    darkStyle: s.darkStyle,
    lightStyle: s.lightStyle,
    uiFont: s.uiFont,
    codeFont: s.codeFont,
  };
  try {
    storage()?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Not remembering it locally only costs the first paint in the default look.
  }
};

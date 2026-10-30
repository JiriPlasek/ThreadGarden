import type { Settings } from '@pahub/protocol';

export type Theme = Settings['theme'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Applies pahub's theme (spec §6.5) as `data-theme="light" | "dark"` on the
 * root element; the stylesheet keys both token sets and Tailwind's `dark:`
 * variant on it. `system` follows the OS preference live. Returns a function
 * that stops following it.
 */
export const applyTheme = (
  theme: Theme,
  root: HTMLElement = document.documentElement,
  media: MediaQueryList = window.matchMedia(DARK_QUERY),
): (() => void) => {
  const set = (dark: boolean): void => {
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
  };
  if (theme !== 'system') {
    set(theme === 'dark');
    return () => {};
  }
  const follow = (): void => set(media.matches);
  follow();
  media.addEventListener('change', follow);
  return () => media.removeEventListener('change', follow);
};

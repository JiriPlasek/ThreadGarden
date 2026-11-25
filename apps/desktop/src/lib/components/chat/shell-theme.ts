import type { ITheme } from '@xterm/xterm';

const FALLBACK_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const LIGHT: Required<ITheme> = pick('#ffffff', '#171717', '#e5e5e5', '#171717');
const DARK: Required<ITheme> = pick('#171717', '#fafafa', '#404040', '#fafafa');

function pick(bg: string, fg: string, sel: string, selFg: string): Required<ITheme> {
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: sel,
    selectionForeground: selFg,
  } as Required<ITheme>;
}

/**
 * `css` as an `rgb()` string, or null when the browser can't parse it. The
 * colour is painted on a canvas and read back, so `oklch()` (which xterm's own
 * canvas parsing may not understand on an older WebKit) becomes plain sRGB.
 */
const toRgb = (css: string): string | null => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = css;
  // An unparseable value leaves the sentinel in place.
  if (ctx.fillStyle === sentinel && css.trim().toLowerCase() !== sentinel) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
};

/** The app's mono font and colours as they are now, colours as `rgb()`; never throws. */
export const terminalLook = (): { fontFamily: string; theme: ITheme } => {
  const root = document.documentElement;
  const fallback = root.dataset.theme === 'dark' ? DARK : LIGHT;
  try {
    const css = getComputedStyle(root);
    const v = (name: string): string => css.getPropertyValue(name).trim();
    const color = (name: string, key: keyof ITheme): string => {
      try {
        const raw = v(name);
        return (raw && toRgb(raw)) || (fallback[key] as string);
      } catch {
        return fallback[key] as string;
      }
    };
    return {
      fontFamily: v('--font-mono') || FALLBACK_FONT,
      theme: {
        background: color('--background', 'background'),
        foreground: color('--foreground', 'foreground'),
        cursor: color('--foreground', 'cursor'),
        cursorAccent: color('--background', 'cursorAccent'),
        selectionBackground: color('--accent', 'selectionBackground'),
        selectionForeground: color('--accent-foreground', 'selectionForeground'),
      },
    };
  } catch {
    return { fontFamily: FALLBACK_FONT, theme: { ...fallback } };
  }
};

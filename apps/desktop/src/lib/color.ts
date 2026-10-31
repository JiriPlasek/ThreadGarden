/**
 * Just enough CSS colour maths to check the theme tokens for WCAG contrast:
 * parses `oklch()`, hex and `color-mix(in oklab, …)` values (with `var()`
 * references resolved by the caller) into sRGB and computes contrast ratios.
 * Pure; the app does not use it at run time.
 */

/** Gamma-encoded sRGB channels in [0, 1] (clipped to the gamut) plus alpha. */
export type Rgba = { r: number; g: number; b: number; alpha: number };
type Oklab = { L: number; a: number; b: number; alpha: number };

/** Looks up a custom property's raw value (`var(--name)` → value), or undefined. */
export type Resolve = (name: string) => string | undefined;

const clip = (x: number): number => Math.min(1, Math.max(0, x));
const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toGamma = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** Linear sRGB of an OKLab colour, unclipped (values outside [0, 1] are out of gamut). */
export const oklabToLinearSrgb = (L: number, a: number, b: number): [number, number, number] => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const linearSrgbToOklab = (r: number, g: number, b: number): [number, number, number] => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const num = (token: string, percentScale = 1): number => {
  const t = token.trim();
  const n = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * percentScale : Number(t);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${token}`);
  return n;
};

/** Splits on commas that are not inside parentheses. */
const splitTopLevel = (s: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
};

/** The text between a function's outer parentheses (`fn(` … `)`). */
const args = (value: string, fn: string): string | null => {
  const v = value.trim();
  if (!v.toLowerCase().startsWith(`${fn}(`) || !v.endsWith(')')) return null;
  return v.slice(fn.length + 1, -1);
};

const parseOklab = (raw: string, resolve: Resolve, depth: number): Oklab => {
  if (depth > 20) throw new Error('var() nesting too deep');
  const value = raw.trim();

  const ref = args(value, 'var');
  if (ref !== null) {
    const [name, fallback] = splitTopLevel(ref);
    const found = resolve(name!.trim()) ?? fallback;
    if (found === undefined) throw new Error(`Unresolved ${value}`);
    return parseOklab(found, resolve, depth + 1);
  }

  const lch = args(value, 'oklch');
  if (lch !== null) {
    const [main, alphaPart] = lch.split('/');
    const [L, C, H] = main!.trim().split(/\s+/);
    if (L === undefined || C === undefined || H === undefined) throw new Error(`Bad ${value}`);
    const l = num(L);
    const c = num(C, 0.4);
    const h = (num(H.replace(/deg$/, '')) * Math.PI) / 180;
    const alpha = alphaPart === undefined ? 1 : num(alphaPart);
    return { L: l, a: c * Math.cos(h), b: c * Math.sin(h), alpha };
  }

  const mix = args(value, 'color-mix');
  if (mix !== null) {
    const [space, first, second] = splitTopLevel(mix);
    if (space !== 'in oklab' || first === undefined || second === undefined) {
      throw new Error(`Only color-mix(in oklab, a p%, b) is supported: ${value}`);
    }
    const part = (s: string): { color: string; p: number | null } => {
      const m = /^(.*?)\s+([\d.]+%)$/.exec(s);
      return m ? { color: m[1]!, p: num(m[2]!) } : { color: s, p: null };
    };
    const A = part(first);
    const B = part(second);
    const pA = A.p ?? (B.p === null ? 0.5 : 1 - B.p);
    const x = parseOklab(A.color, resolve, depth + 1);
    const y = parseOklab(B.color, resolve, depth + 1);
    const t = 1 - pA;
    return {
      L: x.L + (y.L - x.L) * t,
      a: x.a + (y.a - x.a) * t,
      b: x.b + (y.b - x.b) * t,
      alpha: x.alpha + (y.alpha - x.alpha) * t,
    };
  }

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const ch = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
    const [L, a, b] = linearSrgbToOklab(toLinear(ch(0)), toLinear(ch(2)), toLinear(ch(4)));
    return { L, a, b, alpha: h.length === 8 ? ch(6) : 1 };
  }

  throw new Error(`Unsupported colour: ${value}`);
};

/** Parses a colour value into gamma-encoded sRGB (clipped to the gamut, as an sRGB display shows it). */
export const parseColor = (value: string, resolve: Resolve = () => undefined): Rgba => {
  const { L, a, b, alpha } = parseOklab(value, resolve, 0);
  const [r, g, bl] = oklabToLinearSrgb(L, a, b);
  return { r: toGamma(clip(r)), g: toGamma(clip(g)), b: toGamma(clip(bl)), alpha };
};

/** How far outside the sRGB gamut a colour is (0 when inside), in linear-light units. */
export const gamutExcess = (value: string, resolve: Resolve = () => undefined): number => {
  const { L, a, b } = parseOklab(value, resolve, 0);
  return Math.max(0, ...oklabToLinearSrgb(L, a, b).map((c) => Math.max(-c, c - 1)));
};

/** A translucent colour composited over an opaque backdrop (in gamma-encoded sRGB, as browsers do). */
export const over = (top: Rgba, backdrop: Rgba): Rgba => ({
  r: top.r * top.alpha + backdrop.r * (1 - top.alpha),
  g: top.g * top.alpha + backdrop.g * (1 - top.alpha),
  b: top.b * top.alpha + backdrop.b * (1 - top.alpha),
  alpha: 1,
});

/** WCAG 2 relative luminance. */
export const luminance = ({ r, g, b }: Rgba): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** WCAG 2 contrast ratio (1–21) of a text colour on a background; translucent text is composited first. */
export const contrastRatio = (text: Rgba, background: Rgba): number => {
  const fg = text.alpha < 1 ? over(text, background) : text;
  const [hi, lo] = [luminance(fg), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * WCAG AA for every appearance combination (spec v1.3 §6), computed from the
 * real stylesheets: the token blocks of layout.css and themes.css are
 * cascaded for <html> with each theme × style × accent, then every text pair
 * the UI draws and the primary button are checked for 4.5:1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCENTS, DARK_STYLES, LIGHT_STYLES } from '@threadgarden/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { contrastRatio, gamutExcess, parseColor } from '../../src/lib/color';

// In the order the build has them: layout.css imports themes.css at its top.
const css = ['themes.css', 'layout.css']
  .map((f) => readFileSync(resolve(process.cwd(), 'src/routes', f), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Splits on commas outside parentheses. */
const splitList = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
};

/** Specificity (attributes and pseudo-classes only: all these selectors use) as one number. */
const specificity = (selector: string): number => {
  let n = 0;
  let rest = selector;
  for (const fn of ['is', 'not', 'where'] as const) {
    rest = rest.replace(
      new RegExp(`:${fn}\\(((?:[^()]|\\([^()]*\\))*)\\)`, 'g'),
      (_, inner: string) => {
        if (fn !== 'where') n += Math.max(...splitList(inner).map(specificity));
        return '';
      },
    );
  }
  n += (rest.match(/\[/g) ?? []).length + (rest.match(/:root/g) ?? []).length;
  return n;
};

type Block = { selectors: string[]; decls: [string, string][]; order: number };

const blocks: Block[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m, order) => {
    // Drop at-statements (`@import …;`) that precede the selector.
    const selector = m[1]!.split(';').pop()!.trim();
    const decls = m[2]!
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.startsWith('--'))
      .map((d): [string, string] => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      });
    return { selectors: selector.startsWith('@') ? [] : splitList(selector), decls, order };
  })
  .filter((b) => b.selectors.length > 0 && b.decls.length > 0);

const root = document.documentElement;

/** The custom properties <html> ends up with for these attributes. */
const tokensFor = (attrs: Record<string, string>): Map<string, string> => {
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  const applied: { spec: number; order: number; decls: [string, string][] }[] = [];
  for (const b of blocks) {
    const specs = b.selectors.filter((s) => root.matches(s)).map(specificity);
    if (specs.length > 0)
      applied.push({ spec: Math.max(...specs), order: b.order, decls: b.decls });
  }
  applied.sort((x, y) => x.spec - y.spec || x.order - y.order);
  const tokens = new Map<string, string>();
  for (const a of applied) for (const [k, v] of a.decls) tokens.set(k, v);
  return tokens;
};

/** [text, background] pairs the UI draws text with. */
const TEXT_PAIRS: [string, string][] = [
  ['--foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--secondary-foreground', '--secondary'],
  ['--accent-foreground', '--accent'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  // Timestamps and previews in a selected list row.
  ['--muted-foreground', '--accent'],
  // The primary button.
  ['--primary-foreground', '--primary'],
];
const AA = 4.5;

const combos = [
  ...LIGHT_STYLES.map((style) => ({ theme: 'light', attr: 'data-light-style', style })),
  ...DARK_STYLES.map((style) => ({ theme: 'dark', attr: 'data-dark-style', style })),
].flatMap((c) => ACCENTS.map((accent) => ({ ...c, accent })));

const measure = (c: (typeof combos)[number]) => {
  const tokens = tokensFor({ 'data-theme': c.theme, [c.attr]: c.style, 'data-accent': c.accent });
  const color = (name: string) => parseColor(`var(${name})`, (n) => tokens.get(n));
  return TEXT_PAIRS.map(([fg, bg]) => ({
    pair: `${fg} on ${bg}`,
    ratio: Math.round(contrastRatio(color(fg), color(bg)) * 100) / 100,
  }));
};

describe('theme contrast', () => {
  afterEach(() => {
    for (const a of ['data-theme', 'data-light-style', 'data-dark-style', 'data-accent'])
      root.removeAttribute(a);
  });

  it('parses the token sets from the stylesheets', () => {
    const light = tokensFor({ 'data-theme': 'light' });
    expect(light.get('--background')).toBe('oklch(1 0 0)');
    expect(light.get('--primary')).toBe('oklch(0.205 0 0)');
    const dark = tokensFor({ 'data-theme': 'dark' });
    expect(dark.get('--background')).toBe('oklch(0.145 0 0)');
    const midnightBlue = tokensFor({
      'data-theme': 'dark',
      'data-dark-style': 'midnight',
      'data-accent': 'blue',
    });
    expect(midnightBlue.get('--background')).toBe('oklch(0 0 0)');
    expect(midnightBlue.get('--accent')).toMatch(/^color-mix/);
  });

  it('defaults (graphite, default styles) are exactly the pre-v1.3 tokens', () => {
    for (const theme of ['light', 'dark']) {
      const before = tokensFor({ 'data-theme': theme });
      const after = tokensFor({
        'data-theme': theme,
        'data-accent': 'graphite',
        'data-light-style': 'default',
        'data-dark-style': 'default',
        'data-ui-font': 'inter',
      });
      // Inter is stated for the preview; it is the same font list as layout.css's fallback.
      expect(after.get('--font-ui')).toBe("'Inter Variable', sans-serif");
      expect(css).toContain("--font-sans: var(--font-ui, 'Inter Variable', sans-serif);");
      after.delete('--font-ui');
      expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
      root.removeAttribute('data-ui-font');
    }
  });

  it.each(combos)('$theme / $style / $accent keeps AA for text and the primary button', (c) => {
    const failing = measure(c).filter((m) => m.ratio < AA);
    expect(failing).toEqual([]);
  });

  it('the default light look meets AA for muted text too (0.54, was 0.556 before v1.3)', () => {
    const c = combos.find(
      (x) => x.theme === 'light' && x.style === 'default' && x.accent === 'graphite',
    )!;
    const measured = Object.fromEntries(measure(c).map((m) => [m.pair, m.ratio]));
    expect(measured).toMatchObject({
      '--muted-foreground on --muted': 4.64,
      '--muted-foreground on --accent': 4.64,
    });
  });

  it('keeps every new colour inside sRGB (no gamut clipping changes the maths)', () => {
    const outside: string[] = [];
    for (const c of combos) {
      const tokens = tokensFor({
        'data-theme': c.theme,
        [c.attr]: c.style,
        'data-accent': c.accent,
      });
      for (const name of ['--primary', '--primary-foreground', '--background', '--accent']) {
        const excess = gamutExcess(`var(${name})`, (n) => tokens.get(n));
        if (excess > 0.002) outside.push(`${c.theme}/${c.style}/${c.accent} ${name}: ${excess}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('prints the ratios when THREADGARDEN_CONTRAST_REPORT is set', () => {
    if (!process.env.THREADGARDEN_CONTRAST_REPORT) return;
    const header = ['theme', 'style', 'accent', ...TEXT_PAIRS.map(([f, b]) => `${f}/${b}`)];
    const rows = combos.map((c) => [c.theme, c.style, c.accent, ...measure(c).map((m) => m.ratio)]);
    console.log([header, ...rows].map((r) => r.join('\t')).join('\n'));
  });
});

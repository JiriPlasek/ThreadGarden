import { describe, expect, it } from 'vitest';
import { contrastRatio, gamutExcess, luminance, parseColor } from '../../src/lib/color';

const ratio = (a: string, b: string, vars: Record<string, string> = {}): number =>
  contrastRatio(
    parseColor(a, (n) => vars[n]),
    parseColor(b, (n) => vars[n]),
  );

describe('colour maths', () => {
  it('parses hex and oklch to the same sRGB', () => {
    const hexWhite = parseColor('#fff');
    expect(hexWhite.r).toBeCloseTo(1, 6);
    expect(hexWhite.b).toBeCloseTo(1, 6);
    expect(hexWhite.alpha).toBe(1);
    const white = parseColor('oklch(1 0 0)');
    expect(white.r).toBeCloseTo(1, 3);
    expect(white.b).toBeCloseTo(1, 3);
    const black = parseColor('oklch(0 0 0)');
    expect(luminance(black)).toBeCloseTo(0, 6);
    // CSS Color 4's own example: oklch(62.8% 0.2577 29.23) is sRGB red.
    const red = parseColor('oklch(62.8% 0.2577 29.23)');
    expect(red.r).toBeCloseTo(1, 2);
    expect(red.g).toBeCloseTo(0, 2);
    expect(red.b).toBeCloseTo(0, 2);
    expect(parseColor('#3366cc80').alpha).toBeCloseTo(0.5, 2);
    expect(parseColor('oklch(1 0 0 / 10%)').alpha).toBeCloseTo(0.1, 6);
  });

  it('computes WCAG contrast ratios', () => {
    expect(ratio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(ratio('#fff', '#fff')).toBeCloseTo(1, 5);
    // #767676 on white is the classic smallest AA grey (4.54:1).
    expect(ratio('#767676', '#fff')).toBeCloseTo(4.54, 2);
    // Translucent text is composited over the background first.
    expect(ratio('oklch(0 0 0 / 0%)', '#fff')).toBeCloseTo(1, 5);
  });

  it('resolves var() and mixes in OKLab', () => {
    const vars = { '--a': 'oklch(0 0 0)', '--b': 'var(--a)' };
    expect(ratio('var(--b)', '#fff', vars)).toBeCloseTo(21, 3);
    expect(ratio('var(--missing, #000)', '#fff')).toBeCloseTo(21, 3);
    const mid = parseColor('color-mix(in oklab, oklch(1 0 0) 50%, oklch(0 0 0))');
    const ref = parseColor('oklch(0.5 0 0)');
    expect(mid.r).toBeCloseTo(ref.r, 4);
    const quarter = parseColor('color-mix(in oklab, oklch(1 0 0) 25%, oklch(0 0 0))');
    expect(quarter.g).toBeCloseTo(parseColor('oklch(0.25 0 0)').g, 4);
    expect(() => parseColor('var(--nope)')).toThrow();
    expect(() => parseColor('rebeccapurple')).toThrow();
  });

  it('measures how far a colour is outside sRGB', () => {
    expect(gamutExcess('oklch(0.5 0.1 250)')).toBe(0);
    expect(gamutExcess('oklch(0.9 0.3 140)')).toBeGreaterThan(0.05);
  });
});

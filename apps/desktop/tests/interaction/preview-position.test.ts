import { describe, expect, it } from 'vitest';
import { previewPosition } from '../../src/lib/components/composer/preview-position';

describe('attachment preview placement', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 320, height: 306 };
  it('places the measured popup below a badge near the top', () => {
    expect(previewPosition({ left: 400, top: 100, bottom: 120 }, size, viewport)).toEqual({
      left: 400,
      top: 126,
    });
  });
  it('places it above when there is room, including short image previews', () => {
    expect(previewPosition({ left: 400, top: 700, bottom: 720 }, size, viewport)).toEqual({
      left: 400,
      top: 388,
    });
    expect(
      previewPosition({ left: 400, top: 200, bottom: 220 }, { width: 320, height: 100 }, viewport)
        .top,
    ).toBe(94);
  });
  it('keeps the popup inside the right and bottom edges of a small viewport', () => {
    const placed = previewPosition({ left: 980, top: 100, bottom: 120 }, size, {
      width: 1000,
      height: 340,
    });
    expect(placed.left).toBe(672);
    expect(placed.top).toBe(26);
  });
});

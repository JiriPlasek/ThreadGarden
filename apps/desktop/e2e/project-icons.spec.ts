/**
 * Project icons (v1.3 §5): the mock gives some projects a favicon (found by
 * the service's real search in fixture folders); the others get letter tiles.
 */
import { expect, test, type Locator } from '@playwright/test';
import { openApp, resetTabs } from './helpers';

test.beforeEach(resetTabs);

/** A project's row (its accessible name may end with a count badge). */
const projectRow = (places: Locator, n: number) =>
  places.getByRole('button', { name: new RegExp(`^proj-${n}(\\D|$)`) });

test('projects show their favicon or a letter tile', async ({ page }) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });

  // proj-0 has a root favicon.svg; proj-1 links one from index.html.
  for (const n of [0, 1]) {
    const row = projectRow(places, n);
    await row.scrollIntoViewIfNeeded();
    const img = row.locator('img');
    await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
    await expect(img).toHaveAttribute('alt', '');
    // Decoded and drawn at the row-icon size: 1rem, 16 px at a 16 px base font
    // (the interface size scales it like the other row icons).
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const box = await img.boundingBox();
    expect(box?.width).toBeCloseTo(rem, 0);
    expect(box?.height).toBeCloseTo(rem, 0);
  }

  // proj-3 has none: a coloured tile with its letter (CSS content, not row text).
  const row = projectRow(places, 3);
  await row.scrollIntoViewIfNeeded();
  const tile = row.locator('[data-letter]');
  await expect(tile).toHaveAttribute('data-letter', 'P');
  expect(await tile.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"P"');
  expect(await tile.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect((await row.textContent())?.trim()).toMatch(/^proj-3(\D|$)/);
});

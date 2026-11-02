/**
 * The message list in a real browser with real scrollbars (Playwright hides
 * them by default; the Windows webview does not). A row wider than the list
 * (a tool call with a long path, say) used to give the list a horizontal
 * scrollbar only while that row was rendered. The scrollbar changes how far
 * the list can scroll, so following the bottom could flip the row in and out
 * of the rendered window forever: effect_update_depth_exceeded, "Something
 * went wrong" (spec §8b).
 */
import { expect, test, type Locator } from '@playwright/test';
import { chatRow, openApp, resetTabs } from './helpers';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.beforeEach(resetTabs);

type Geometry = {
  /** Thickness of a horizontal scrollbar. */
  bar: number;
  scrollTop: number;
  max: number;
  /** From the top of the view to the next row's top. */
  gap: number;
  /** The first rendered row (overscan included). */
  first: string;
};

const geometry = (list: Locator): Promise<Geometry> =>
  list.evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-999px;width:99px;height:99px;overflow:scroll';
    document.body.append(probe);
    const bar = probe.offsetHeight - probe.clientHeight;
    probe.remove();
    const rows = [...el.querySelectorAll<HTMLElement>('[data-row]')].map((r) => ({
      key: r.dataset.row!,
      top: Number(r.dataset.top),
    }));
    const next = rows.find((r) => r.top > el.scrollTop);
    return {
      bar,
      scrollTop: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      gap: next ? next.top - el.scrollTop : 0,
      first: rows[0]!.key,
    };
  });

/** Waits until the list has stopped moving (rows measured, at the bottom). */
const settled = async (list: Locator): Promise<Geometry> => {
  let last = await geometry(list);
  await expect
    .poll(async () => {
      const now = await geometry(list);
      const same = now.scrollTop === last.scrollTop && now.max === last.max;
      last = now;
      return same && now.scrollTop === now.max;
    })
    .toBe(true);
  return last;
};

test('a row wider than the list does not make following the bottom loop', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await openApp(page);
  await (await chatRow(page, 'session-big')).click();
  const list = page.getByRole('region', { name: 'Messages' });
  await expect(list.locator('[data-row]').first()).toBeVisible();
  // Rows of 40 px make the geometry below exact (the mock's messages are ~2,000 px each).
  await page.addStyleTag({
    content: '[data-viewport] [data-row] { height: 40px; overflow: hidden; }',
  });
  const before = await settled(list);
  expect(before.bar).toBeGreaterThan(1);

  // The first rendered row becomes wider than the list (which used to show a horizontal
  // scrollbar for it).
  await page.addStyleTag({ content: `[data-row="${before.first}"] { min-width: 3000px; }` });
  // The window gets a little shorter (as when the composer grows), so the list re-reads
  // its height (under that scrollbar, it used to) and follows the bottom again. Chosen so
  // a row's top then sits less than a scrollbar's thickness below the top of the view:
  // there the wide row used to drop out of the rendered window, and with it the scrollbar.
  const size = page.viewportSize()!;
  await page.setViewportSize({
    width: size.width,
    height: size.height - Math.round(before.gap - before.bar / 2),
  });

  // The resize reaches the list's ResizeObserver within a frame or two.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
  expect(errors.filter((e) => /effect_update_depth_exceeded/.test(e))).toEqual([]);
  await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toHaveCount(0);
  await settled(list);
});

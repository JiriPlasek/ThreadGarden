/**
 * Dense, fixed-height rows must hold their content at every interface size
 * (80 %–150 % of the 17 px base): the chat list's virtual rows, the tabs bar,
 * the chat header, the running-agents strip and the places column.
 */
import { expect, test, type Page } from '@playwright/test';
import { openApp, resetTabs, serviceCall } from './helpers';

const SCALE_KEY = 'interface.scale';

test.beforeEach(resetTabs);
// The mock service keeps uiState between tests: leave the default size behind.
test.afterEach(async () => {
  await serviceCall('uiState.set', { key: SCALE_KEY, value: 1 });
});

/** A row's height, its scroll height and the height its children span (all px). */
type Box = { name: string; client: number; scroll: number; content: number };

/** Every dense row on screen. */
const measure = (page: Page) =>
  page.evaluate((): Box[] => {
    const boxes: Box[] = [];
    const add = (name: string, el: Element | null): void => {
      if (!(el instanceof HTMLElement)) return;
      const kids = [...el.children].map((c) => c.getBoundingClientRect());
      const content = kids.length
        ? Math.max(...kids.map((r) => r.bottom)) - Math.min(...kids.map((r) => r.top))
        : 0;
      boxes.push({
        name,
        client: el.clientHeight,
        scroll: el.scrollHeight,
        content: Math.round(content * 10) / 10,
      });
    };
    const rows = document.querySelectorAll('[aria-label="Chat list"] [role="option"]');
    rows.forEach((r, i) => i < 5 && add(`chat list row ${i}`, r));
    add('tabs bar', document.querySelector('[role="tablist"]')?.parentElement ?? null);
    document
      .querySelectorAll('#chat-panel header > div')
      .forEach((r, i) => add(`chat header line ${i}`, r));
    add('agents strip', document.querySelector('footer'));
    document
      .querySelectorAll('nav[aria-label="Places"] button')
      .forEach((b, i) => i < 4 && add(`places button ${i}`, b));
    return boxes;
  });

for (const [label, presses] of [
  ['80 %', { key: 'ControlOrMeta+Minus', times: 2 }],
  ['100 %', { key: 'ControlOrMeta+0', times: 1 }],
  ['150 %', { key: 'ControlOrMeta+Equal', times: 5 }],
] as const) {
  test(`dense rows hold their content at ${label}`, async ({ page }) => {
    await openApp(page);
    await page
      .getByRole('region', { name: 'Chat list' })
      .locator('[role="option"][data-session-id="session-996"]')
      .click();
    await expect(page.locator('#chat-panel header')).toBeVisible();
    for (let i = 0; i < presses.times; i++) await page.keyboard.press(presses.key);
    const scale = Number(label.replace(' %', '')) / 100;
    await expect
      .poll(() =>
        page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)),
      )
      .toBeCloseTo(17 * scale, 1);

    const boxes = await measure(page);
    console.info(
      `${label}: ${boxes.map((b) => `${b.name} ${b.content} in ${b.client}px`).join(', ')}`,
    );
    expect(boxes.length).toBeGreaterThan(8);
    const clipped = boxes.filter((b) => b.scroll > b.client + 1 || b.content > b.client + 1);
    expect(clipped).toEqual([]);
  });
}

/**
 * Ruling R30: with background tasks present, the Activity panel never squeezes
 * the chat. Narrow chat panes get it as an overlay drawer (opened on request,
 * the messages and composer keep their width); wide ones as a side column of
 * at most 40 % of the pane. Its controls stay on screen either way.
 */
for (const c of [
  { width: 720, scale: '100 %', presses: 0, session: 975, overlay: true },
  { width: 1200, scale: '150 %', presses: 5, session: 974, overlay: true },
  { width: 1400, scale: '100 %', presses: 0, session: 973, overlay: false },
] as const) {
  test(`activity panel fits a ${c.width} px window at ${c.scale}`, async ({ page }) => {
    await page.setViewportSize({ width: c.width, height: 900 });
    await openApp(page);
    // The mock's session-N belongs to proj-(N mod 50): its project lists it near the top.
    await page
      .getByRole('navigation', { name: 'Places' })
      .getByRole('button', { name: new RegExp(`^proj-${c.session % 50}( \\d+)?$`) })
      .click();
    await page
      .getByRole('region', { name: 'Chat list' })
      .locator(`[role="option"][data-session-id="session-${c.session}"]`)
      .click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Start the dev server');
    await composer.press('Enter');
    await expect(page.getByRole('tab', { selected: true })).toContainText('1 running');
    for (let i = 0; i < c.presses; i++) await page.keyboard.press('ControlOrMeta+Equal');

    const activity = page.getByRole('region', { name: 'Activity' });
    if (c.overlay) {
      // Tasks alone do not cover a narrow chat; Ctrl+. opens the drawer.
      await expect(activity).toHaveCount(0);
      const before = (await composer.boundingBox())!.width;
      await page.keyboard.press('ControlOrMeta+.');
      await expect(activity).toHaveAttribute('data-overlay', 'true');
      expect((await composer.boundingBox())!.width).toBeCloseTo(before, 0);
    } else {
      await expect(activity).toBeVisible();
      await expect(activity).not.toHaveAttribute('data-overlay');
      const body = (await page.locator('[data-chat-body]').boundingBox())!;
      const panel = (await activity.boundingBox())!;
      expect(panel.width).toBeLessThanOrEqual(body.width * 0.4 + 1);
      expect((await composer.boundingBox())!.width).toBeGreaterThanOrEqual(240);
    }

    for (const control of [
      activity.getByRole('button', { name: 'Hide activity' }),
      activity.getByRole('button', { name: 'Stop npm run dev' }),
    ]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(c.width);
    }

    if (c.overlay) {
      await page.keyboard.press('Escape');
      await expect(activity).toHaveCount(0);
    }
  });
}

/**
 * Spec §8 UI budgets, measured in the page (see `helpers.ts`): from the real
 * click or key event to the DOM showing the result, plus a style and layout
 * pass. Budgets are multiplied by `PAHUB_PERF_SLACK` (CI: 3, ruling R3).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  chatRow,
  fmt,
  median,
  openApp,
  resetTabs,
  serviceCall,
  slack,
  timeClick,
  timeKey,
  type DoneWhen,
} from './helpers';

test.beforeEach(resetTabs);
// Trace snapshots run inside the page around every action and would be measured.
test.use({ trace: 'off' });

/** The chat pane shows `sessionId`'s messages. */
const showing = (sessionId: string): DoneWhen => ({
  selector: `#chat-panel[aria-labelledby="tab-${sessionId}"] [data-row^="${sessionId}-m"]`,
});

/** Scrolls the row into the DOM first (not measured), then times the click. */
const openFromList = async (page: Page, sessionId: string): Promise<number> => {
  const row = await chatRow(page, sessionId);
  return timeClick(page, () => row.click(), showing(sessionId));
};

test('tab switch ≤ 50 ms', async ({ page }) => {
  await openApp(page);
  const ids = ['session-990', 'session-991', 'session-992'];
  for (const id of ids) await openFromList(page, id);
  const times: number[] = [];
  // Round-robin through the tabs: every switch shows another chat.
  for (let i = 0; i < 10; i++) {
    const id = ids[i % ids.length]!;
    times.push(
      await timeClick(
        page,
        () => page.locator(`[role="tab"][data-tab="${id}"]`).click(),
        showing(id),
      ),
    );
  }
  const measured = times.slice(1); // the first switch warms up
  console.info(`tab switch: median ${median(measured).toFixed(1)} ms (${fmt(measured)})`);
  expect(median(measured)).toBeLessThanOrEqual(50 * slack);
});

test('history chat open ≤ 150 ms', async ({ page }) => {
  await openApp(page);
  await openFromList(page, 'session-989'); // warm-up: lazy UI code, first request
  const times: number[] = [];
  for (const id of ['session-988', 'session-987', 'session-986', 'session-985', 'session-984']) {
    times.push(await openFromList(page, id));
  }
  console.info(`history chat open: median ${median(times).toFixed(1)} ms (${fmt(times)})`);
  expect(median(times)).toBeLessThanOrEqual(150 * slack);
});

test('Ctrl+K keystroke ≤ 50 ms', async ({ page }) => {
  await openApp(page);
  const base = 'Summary ';
  const keys = ['4', '2', '7'];
  // What the switcher must show after each keystroke (its 20 chat hits, in order).
  const expected: string[][] = [];
  for (let i = 1; i <= keys.length; i++) {
    const query = base + keys.slice(0, i).join('');
    const { items } = await serviceCall<{ items: { sessionId: string }[] }>('search.quick', {
      query,
      limit: 20,
    });
    expected.push(items.map((h) => `chat:${h.sessionId}`));
  }
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search chats' });
  await expect(input).toBeFocused();
  await input.fill(base);
  await expect(page.locator('#quick-list li[data-key^="chat:"]').first()).toBeVisible();

  const times: number[] = [];
  for (const [i, key] of keys.entries()) {
    times.push(
      await timeKey(page, () => page.keyboard.press(key), {
        selector: '#quick-list',
        keys: expected[i]!,
        keysSelector: '#quick-list li[data-key]',
      }),
    );
  }
  console.info(`Ctrl+K keystroke: max ${Math.max(...times).toFixed(1)} ms (${fmt(times)})`);
  expect(Math.max(...times)).toBeLessThanOrEqual(50 * slack);
});

test('composer keystroke ≤ 16 ms', async ({ page }) => {
  await openApp(page);
  await openFromList(page, 'session-983');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.pressSequentially('warm up ');
  const times: number[] = [];
  for (const ch of 'the quick brown fox jumps') {
    times.push(await timeKey(page, () => page.keyboard.press(ch === ' ' ? 'Space' : ch), null));
  }
  await expect(composer).toHaveValue('warm up the quick brown fox jumps');
  const p90 = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.9) - 1]!;
  console.info(
    `composer keystroke: median ${median(times).toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms`,
  );
  // The 90th percentile: a rare GC pause on a shared CI runner is not the app's doing.
  expect(p90).toBeLessThanOrEqual(16 * slack);
});

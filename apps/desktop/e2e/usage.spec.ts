import { expect, test } from '@playwright/test';
import { markAllSeen, openApp, resetTabs } from './helpers';

/*
 * v1.3 B: the per-account usage chip and a chat refused by the (mock) usage limit. The
 * mock stays refused for two minutes after "limit", so this spec runs last
 * (file order) and leaves nothing scheduled behind.
 */
test.beforeEach(async () => {
  await resetTabs();
  await markAllSeen();
});

test('usage meter, Usage dialog, limit notice and "Send when the limit resets"', async ({
  page,
}) => {
  await openApp(page);
  const meter = page.getByRole('button', { name: /^Usage: .*5-hour limit/ }).first();
  await expect(meter).toContainText('%');
  await meter.click();
  const dialog = page.getByRole('dialog', { name: 'Usage' });
  await expect(dialog.getByRole('meter', { name: '5-hour limit used' }).first()).toBeVisible();
  await expect(dialog.getByRole('meter', { name: 'Weekly limit used' }).first()).toBeVisible();
  // A long machine name or email truncates; it never widens the dialog past its edge.
  await dialog.locator('section h3').first().evaluate((h) => {
    h.textContent = `kumbal-machine-Z270-Gaming-K3-${'x'.repeat(80)}`;
  });
  expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press('Escape');

  const list = page.getByRole('region', { name: 'Chat list' });
  await list.locator('[role="option"][data-session-id="session-996"]').click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Use up the limit');
  await composer.press('Enter');
  await expect(page.getByText(/^Usage limit reached — resets at \d\d:\d\d$/)).toBeVisible();
  await expect(meter).toContainText('Limit reached');

  await composer.fill('Carry on once it resets');
  await page.getByRole('button', { name: 'Send when the limit resets' }).click();
  const scheduled = page.getByRole('region', { name: 'Scheduled messages' });
  await expect(scheduled).toContainText('Carry on once it resets');
  await expect(scheduled).toContainText('(limit reset)');
  await expect(
    page.getByRole('tab', { selected: true }).getByRole('img', { name: /1 scheduled message/ }),
  ).toBeVisible();
  await scheduled.getByRole('button', { name: 'Cancel scheduled message' }).click();
  await expect(scheduled).toHaveCount(0);
});

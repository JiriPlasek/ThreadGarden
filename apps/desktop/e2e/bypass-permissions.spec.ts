import { expect, test } from '@playwright/test';
import { openApp, resetTabs } from './helpers';

test.beforeEach(resetTabs);

test('bypass requires confirmation in the chat header and New chat; Cancel keeps the prior mode', async ({
  page,
}) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(composer).toHaveText('');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const headerMode = page.getByRole('combobox', { name: 'Permission mode', exact: true });
  await headerMode.selectOption('plan');
  await expect(headerMode).toHaveValue('plan');
  await headerMode.selectOption('bypassPermissions');
  const confirmation = page.getByRole('alertdialog', { name: 'Enable bypass permissions?' });
  await expect(confirmation).toBeVisible();
  await expect(headerMode).toHaveValue('plan');
  // Each button is as wide as its label, inside the dialog.
  const enable = confirmation.getByRole('button', {
    name: 'Enable bypass permissions',
    exact: true,
  });
  expect(await enable.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
  const [box, dialogBox] = [await enable.boundingBox(), await confirmation.boundingBox()];
  expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  const cancelBox = await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .boundingBox();
  expect(Math.abs(cancelBox!.y - box!.y)).toBeLessThan(box!.height / 2); // one row
  // At the dialog's two sides, only its padding (p-5) from each edge.
  expect(cancelBox!.x - dialogBox!.x).toBeLessThan(24);
  expect(dialogBox!.x + dialogBox!.width - (box!.x + box!.width)).toBeLessThan(24);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(headerMode).toHaveValue('plan');
  await headerMode.selectOption('bypassPermissions');
  await confirmation
    .getByRole('button', { name: 'Enable bypass permissions', exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(headerMode).toHaveValue('bypassPermissions');
  await headerMode.selectOption('default');
  await expect(headerMode).toHaveValue('default');

  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New chat', exact: true });
  const newMode = dialog.getByRole('combobox', { name: 'Permission mode', exact: true });
  await newMode.selectOption('acceptEdits');
  await newMode.selectOption('bypassPermissions');
  await expect(confirmation).toBeVisible();
  await expect(newMode).toHaveValue('acceptEdits');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(newMode).toHaveValue('acceptEdits');
  await newMode.selectOption('bypassPermissions');
  await confirmation
    .getByRole('button', { name: 'Enable bypass permissions', exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(newMode).toHaveValue('bypassPermissions');
  await newMode.focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

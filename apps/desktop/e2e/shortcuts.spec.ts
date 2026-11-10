import { expect, test } from '@playwright/test';
import { openApp, resetTabs, serviceCall } from './helpers';

test.beforeEach(async () => {
  await resetTabs();
});

test('shortcut hints appear in tooltips and menus, and F2 renames the active chat', async ({
  page,
}, testInfo) => {
  await openApp(page);
  const newChat = page.getByRole('button', { name: 'New chat', exact: true });
  await newChat.hover();
  const tooltip = page.locator('[data-tooltip-content]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('[data-shortcut-hint]')).toHaveText('Ctrl+N');
  await page.screenshot({
    path: testInfo.outputPath('shortcut-tooltip.png'),
    animations: 'disabled',
  });

  const row = page.locator('[role="option"][data-session-id="session-998"]');
  await row.click({ button: 'right' });
  const renameItem = page.getByRole('menuitem', { name: 'Rename…', exact: true });
  await expect(renameItem.locator('[data-shortcut-hint]')).toHaveText('F2');
  await expect(
    page.getByRole('menuitem', { name: 'Archive', exact: true }).locator('[data-shortcut-hint]'),
  ).toHaveText('E');
  await page.screenshot({ path: testInfo.outputPath('shortcut-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  await row.click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Loading…');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('A draft that survives renaming');
  await composer.press('F2');
  const dialog = page.getByRole('dialog', { name: 'Rename chat', exact: true });
  const title = dialog.getByRole('textbox', { name: 'Chat title' });
  await expect(title).toBeFocused();
  await title.fill('Renamed using F2');
  try {
    await title.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed using F2');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Renamed using F2');
    await expect(row).toContainText('Renamed using F2');
    await expect(composer).toHaveValue('A draft that survives renaming');
    await page.getByRole('button', { name: 'Chat state', exact: true }).click();
    await expect(
      page.getByRole('menuitem', { name: 'Rename…', exact: true }).locator('[data-shortcut-hint]'),
    ).toHaveText('F2');
    await page.screenshot({
      path: testInfo.outputPath('chat-actions.png'),
      animations: 'disabled',
    });
  } finally {
    await serviceCall('meta.update', { sessionId: 'session-998', customTitle: null });
  }
});

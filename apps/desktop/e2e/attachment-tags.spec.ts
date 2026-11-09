import { expect, test } from '@playwright/test';
import { openApp, resetTabs, slack, timeKey } from './helpers';

test.beforeEach(resetTabs);

test('typing with three collapsed 5,000-line pastes stays within 16 ms', async ({ page }) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Logs: ');
  for (let i = 0; i < 3; i++) {
    await box.evaluate((el) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/plain',
        Array(5000).fill('large log entry with details').join('\n'),
      );
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect(box).toHaveValue(new RegExp(`Pasted text #${i + 1}`));
  }
  const times: number[] = [];
  for (const key of 'thequickbrownfox') {
    times.push(await timeKey(page, () => page.keyboard.press(key), null));
  }
  const p90 = times.sort((a, b) => a - b)[Math.ceil(times.length * 0.9) - 1]!;
  console.info(`composer with 15,000 collapsed lines: p90 ${p90.toFixed(1)} ms`);
  expect(p90).toBeLessThanOrEqual(16 * slack);
  await box.fill('');
});

test('paste badges wrap, preview, undo and survive tab switches', async ({ page }) => {
  await openApp(page);
  const list = page.getByRole('region', { name: 'Chat list' });
  await list.locator('[data-session-id="session-998"]').click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Check the following log: ');
  await box.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/plain',
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  });
  await expect(box).toHaveValue('Check the following log: [Pasted text #1 +40 lines]');
  const mirror = page.locator('.mirror [data-tag]').last();
  const rect = await mirror.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + 6, rect!.y + 6);
  await expect(page.getByRole('tooltip')).toContainText('line 40');
  await box.press('Control+z');
  await expect(box).toHaveValue('Check the following log: ');
  await box.press('Control+Shift+z');
  await expect(box).toHaveValue('Check the following log: [Pasted text #1 +40 lines]');

  await list.locator('[data-session-id="session-997"]').click();
  await list.locator('[data-session-id="session-998"]').click();
  await expect(box).toHaveValue('Check the following log: [Pasted text #1 +40 lines]');
  await page.screenshot({ path: 'test-results/attachment-tags.png' });
  await box.press('Enter');
  const messages = page.getByLabel('Messages', { exact: true });
  const badge = messages.getByRole('button', { name: '[Pasted text #1 +40 lines]', exact: true });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(messages.getByLabel('Pasted text #1', { exact: true })).toBeVisible();
});

import { expect, test } from '@playwright/test';
import { openApp, resetTabs, slack, timeKey } from './helpers';

test.beforeEach(resetTabs);

test('chips delete as a whole, copy with their content, and support pinned and wheel previews', async ({
  page,
}) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('first');
  await box.press('Shift+Enter');
  await box.pressSequentially('second');
  await expect(box).toHaveText('first\nsecond');
  await box.fill('before ');
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      'text/plain',
      Array.from({ length: 100 }, (_, i) => `log line ${i + 1}`).join('\n'),
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const chip = box.locator('[data-attachment]');
  await expect(chip).toHaveAttribute('contenteditable', 'false');
  await chip.hover();
  const popup = page.getByRole('tooltip', { name: '[Pasted text #1 +100 lines]', exact: true });
  await expect(popup).toBeVisible();
  await page.mouse.wheel(0, 160);
  await expect.poll(() => popup.locator('pre').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await chip.click();
  await page.mouse.move(300, 100);
  // Outlast the hover-dismiss delay: clicking must pin the preview.
  await page.waitForTimeout(250);
  await expect(popup).toBeVisible();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(popup).toHaveCount(0);

  await box.focus();
  await box.press('Control+End');
  await box.press('ArrowLeft');
  // An arrow crosses the whole chip, so typing inserts beside it.
  await box.press('x');
  await expect(box).toHaveText('before x[Pasted text #1 +100 lines]');
  await box.press('Control+End');
  await box.press('Backspace');
  await expect(box).toHaveText('before x');
  await box.press('Control+z');
  await expect(chip).toHaveCount(1);

  const copied = await box.evaluate((el) => {
    const chip = el.querySelector('[data-attachment]')!;
    const range = document.createRange();
    range.selectNode(chip);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return {
      plain: data.getData('text/plain'),
      message: data.getData('application/x-threadgarden-message'),
    };
  });
  await expect(chip).toHaveCount(0);
  expect(copied.plain).toContain('log line 100');
  await box.evaluate((el, copied) => {
    const data = new DataTransfer();
    data.setData('text/plain', copied.plain);
    data.setData('application/x-threadgarden-message', copied.message);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, copied);
  await expect(chip).toHaveText('[Pasted text #2 +100 lines]');
  await box.press('Enter');
  const sentBadge = page
    .getByLabel('Messages', { exact: true })
    .getByRole('button', { name: '[Pasted text #1 +100 lines]', exact: true });
  await sentBadge.hover();
  await expect(popup).toBeVisible();
  await page.mouse.wheel(0, 160);
  await expect.poll(() => popup.locator('pre').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const messages = page.getByLabel('Messages', { exact: true });
  const scrolled = await messages.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -80);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(await messages.evaluate((el) => el.scrollTop)).toBe(scrolled);
  await sentBadge.click();
  await page.mouse.move(300, 100);
  await page.waitForTimeout(250);
  await expect(popup).toBeVisible();
  await box.click();
  await expect(popup).toHaveCount(0);
});

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
    await expect(box).toHaveText(new RegExp(`Pasted text #${i + 1}`));
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
  await expect(box).toHaveText('Check the following log: [Pasted text #1 +40 lines]');
  const mirror = box.locator('[data-attachment]').last();
  const rect = await mirror.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + 6, rect!.y + 6);
  await expect(page.getByRole('tooltip')).toContainText('line 40');
  await box.press('Control+z');
  await expect(box).toHaveText('Check the following log: ');
  await box.press('Control+Shift+z');
  await expect(box).toHaveText('Check the following log: [Pasted text #1 +40 lines]');

  await list.locator('[data-session-id="session-997"]').click();
  await list.locator('[data-session-id="session-998"]').click();
  await expect(box).toHaveText('Check the following log: [Pasted text #1 +40 lines]');
  await page.screenshot({ path: 'test-results/attachment-tags.png' });
  await box.press('Enter');
  const messages = page.getByLabel('Messages', { exact: true });
  const badge = messages.getByRole('button', { name: '[Pasted text #1 +40 lines]', exact: true });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(
    messages.getByRole('tooltip', { name: '[Pasted text #1 +40 lines]', exact: true }),
  ).toBeVisible();
});

import { expect, test } from '@playwright/test';
import { openApp, resetTabs, serviceCall, slack, timeKey } from './helpers';

const endOfMessage = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

test.beforeEach(async () => {
  await resetTabs();
  // All specs share one mock service. A failed test must not leave paste
  // contents/counters in the next test's restored draft.
  await serviceCall('drafts.set', { key: 'session-998', text: '' });
});

test('sent previews escape virtual-list clipping and follow badges near the top while scrolling', async ({
  page,
}) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Preview placement example: ');
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', Array(100).fill('sample log line').join('\n'));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await box.press('Enter');
  await expect(box).toHaveText('');
  await box.fill('context '.repeat(400));
  await box.press('Enter');
  await expect(box).toHaveText('');
  const messages = page.getByLabel('Messages', { exact: true });
  const badge = messages.getByRole('button', { name: '[Pasted text #1 +100 lines]', exact: true });
  await badge.scrollIntoViewIfNeeded();
  const offset = (await badge.boundingBox())!.y - (await messages.boundingBox())!.y - 24;
  await messages.evaluate((el, offset) => {
    el.scrollTop += offset;
  }, offset);
  await badge.click();
  await page.mouse.move(300, 100);
  const popup = page.getByRole('tooltip', { name: '[Pasted text #1 +100 lines]', exact: true });
  await expect(popup).toBeVisible();
  expect(await popup.evaluate((el) => el.parentElement === document.body)).toBe(true);
  expect(
    await messages
      .locator(':scope > div > div')
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42),
  ).toBeGreaterThan(0);
  const gap = async () => {
    const a = (await badge.boundingBox())!;
    const p = (await popup.boundingBox())!;
    return Math.round(p.y - a.y - a.height);
  };
  await expect.poll(gap).toBe(6);
  await messages.evaluate((el) => {
    el.scrollTop -= 20;
  });
  await expect.poll(gap).toBe(6);
  await page.setViewportSize({ width: 1050, height: 650 });
  await expect.poll(gap).toBe(6);
  const p = (await popup.boundingBox())!;
  expect(p.x).toBeGreaterThanOrEqual(8);
  expect(p.x + p.width).toBeLessThanOrEqual(1042);
  expect(p.y + p.height).toBeLessThanOrEqual(642);
  await page.screenshot({ path: 'test-results/preview-placement.png' });
});

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
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(chip).toHaveCSS('color', 'rgb(186, 230, 253)');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect(chip).toHaveCSS('color', 'rgb(12, 74, 110)');
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
  await box.press(endOfMessage);
  await box.press('ArrowLeft');
  // An arrow crosses the whole chip, so typing inserts beside it.
  await box.press('x');
  await expect(box).toHaveText('before x[Pasted text #1 +100 lines]');
  await box.press(endOfMessage);
  await box.press('Backspace');
  await expect(box).toHaveText('before x');
  await box.press('ControlOrMeta+z');
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
  // Streaming legitimately moves the message list while it follows the tail.
  // Measure wheel isolation only after that turn has settled.
  await expect(box).toHaveText('');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const sentBadge = page
    .getByLabel('Messages', { exact: true })
    .getByRole('button', { name: '[Pasted text #1 +100 lines]', exact: true })
    .last();
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
  await box.press('ControlOrMeta+z');
  await expect(box).toHaveText('Check the following log: ');
  await box.press('ControlOrMeta+Shift+z');
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
    page.getByRole('tooltip', { name: '[Pasted text #1 +40 lines]', exact: true }),
  ).toBeVisible();
});

test('an IME composition beside a chip (a Czech dead key, then Japanese) commits and undoes cleanly', async ({
  page,
  browserName,
}) => {
  // Real IME input goes through the renderer's composition path; only Chromium exposes it.
  test.skip(browserName !== 'chromium', 'CDP Input.imeSetComposition is Chromium-only');
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('');
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(box.locator('[data-attachment]')).toHaveCount(1);
  await box.focus();
  await box.press(endOfMessage);
  const cdp = await page.context().newCDPSession(page);
  const compose = (text: string) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  // Czech on a desktop keyboard: the dead key ´ composes, then e commits é.
  await compose('´');
  await cdp.send('Input.insertText', { text: 'é' });
  // Then a CJK IME: several composition steps, one commit.
  for (const step of ['n', 'ni', 'にほ', '日本']) await compose(step);
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(box).toHaveText('[Pasted text #1 +20 lines]é日本');
  await expect(box.locator('[data-attachment]')).toHaveCount(1);
  await box.press('ControlOrMeta+z');
  await expect(box).toHaveText('[Pasted text #1 +20 lines]é');
  await box.press('ControlOrMeta+z');
  await expect(box).toHaveText('[Pasted text #1 +20 lines]');
  await expect(box.locator('[data-attachment]')).toHaveCount(1);
});

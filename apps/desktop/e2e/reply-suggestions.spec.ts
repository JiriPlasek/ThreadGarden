import { expect, test } from '@playwright/test';
import { openApp, resetTabs } from './helpers';

test('a predicted reply is visible, Tab accepts it and Enter sends it', async ({ page }) => {
  await resetTabs();
  await openApp(page);
  const list = page.getByRole('region', { name: 'Chat list' });
  await list.locator('[role="option"][data-session-id="session-998"]').click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Please suggest a follow-up');
  await composer.press('Enter');
  const accept = page.getByRole('button', { name: 'Tab to accept suggestion' });
  await expect(accept).toBeVisible();
  await expect(composer).toHaveValue('');
  const ghost = page
    .locator('[aria-hidden="true"]')
    .filter({ hasText: /^Run the tests and fix any failures$/ });
  await expect(ghost).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('reply-suggestion.png') });
  await composer.press('Enter');
  await expect(accept).toBeVisible();
  await composer.press('Tab');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Run the tests and fix any failures');
  await expect(accept).toHaveCount(0);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.getByText('Run the tests and fix any failures', { exact: true })).toBeVisible();
});

import { expect, test } from '@playwright/test';
import type { ChatSummary } from '@threadgarden/protocol';
import { markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

test('token volume sits before the time in Active and project chat lists', async ({ page }) => {
  await resetTabs();
  await markAllSeen();
  await openApp(page);
  const { items } = await serviceCall<{ items: ChatSummary[] }>('sessions.summaries', {
    sessionIds: ['session-998'],
  });
  const total = items[0]!.totalTokens!;
  expect(total).toBeGreaterThan(0);
  const list = page.getByRole('region', { name: 'Chat list' });
  const row = list.locator('[role="option"][data-session-id="session-998"]');
  const volume = row.locator('[data-chat-volume]');
  const label = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(total);
  await expect(volume).toHaveText(label);
  await expect(volume).toHaveAttribute('title', /recorded tokens/);
  const countBox = (await volume.boundingBox())!;
  const timeBox = (await row.locator('time').boundingBox())!;
  expect(countBox.x + countBox.width).toBeLessThan(timeBox.x);
  expect(Math.abs(countBox.y + countBox.height / 2 - timeBox.y - timeBox.height / 2)).toBeLessThan(
    2,
  );
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: 'proj-48', exact: true })
    .click();
  await expect(volume).toHaveText(label);
  await list.screenshot({ path: 'test-results/chat-volume.png' });
});

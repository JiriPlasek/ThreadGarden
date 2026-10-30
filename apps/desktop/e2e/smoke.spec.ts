import { expect, test } from '@playwright/test';
import { openApp, resetTabs } from './helpers';

test.beforeEach(resetTabs);

test('open app, needs-you badge shows, open chat, answer permission', async ({ page }) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });
  const list = page.getByRole('region', { name: 'Chat list' });
  const needsYou = places.locator('[title="Chats waiting for you"]');
  await expect(needsYou).toHaveCount(0);

  // Open a chat from the history and ask for something that needs a permission.
  const chat = list.locator('[role="option"][data-session-id="session-998"]');
  await chat.click();
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAttribute('data-tab', 'session-998');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');

  // The badge counts it; then look at another chat meanwhile.
  await expect(needsYou).toHaveText('1');
  // v1.2 §2: the waiting chat leads the list, in "Now"; the mock's history is older than 30 days.
  await expect(list.locator('[role="option"]').first()).toHaveAttribute(
    'data-session-id',
    'session-998',
  );
  await expect(list.locator('[data-section-header="now"]').first()).toContainText('Now');
  await expect(list.locator('[data-section-header="older"]').first()).toContainText('Older');
  await list.locator('[role="option"][data-session-id="session-997"]').click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
    'data-tab',
    'session-997',
  );

  // "Needs you" lists exactly that chat; opening it shows the request.
  await places.getByRole('button', { name: /Needs you/ }).click();
  const waiting = list.locator('[role="option"][data-session-id]');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toHaveAttribute('data-session-id', 'session-998');
  await waiting.click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
    'data-tab',
    'session-998',
  );
  const request = page.getByRole('group', { name: 'Permission request: Bash' });
  await expect(request).toBeVisible();
  await expect(request).toContainText('ls -la');

  // Allow it: the fake Claude Code runs the command and answers; nothing waits any more.
  await request.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(
    page.getByText('There are three entries: README.md, package.json and src.'),
  ).toBeVisible();
  await expect(needsYou).toHaveCount(0);
});

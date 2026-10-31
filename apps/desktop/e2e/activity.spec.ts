import { expect, test } from '@playwright/test';
import { chatRow, openApp, resetTabs } from './helpers';

test.beforeEach(resetTabs);

test('activity panel: a subagent runs and ends, a dev server runs and is stopped', async ({
  page,
}) => {
  await openApp(page);
  const list = page.getByRole('region', { name: 'Chat list' });
  await (await chatRow(page, 'session-979')).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
    'data-tab',
    'session-979',
  );
  const composer = page.getByRole('textbox', { name: 'Message' });
  const activity = page.getByRole('region', { name: 'Activity' });
  // v1.3: the panel is one global setting, shown on a history chat too.
  await expect(activity).toContainText('Activity is available for chats running in pahub');

  // "agent": an Explore subagent reports progress, then completes.
  await composer.fill('Let an agent explore the code');
  await composer.press('Enter');
  const agents = activity.getByRole('list', { name: 'Agents' });
  const agent = agents.getByRole('listitem').filter({ hasText: 'Explore the project structure' });
  await expect(agent).toBeVisible();
  await expect(agent.getByRole('img', { name: 'Running' })).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toContainText('1 running');
  await expect(agent).toContainText(/\d+ tools?/);
  await expect(agent.getByRole('img', { name: 'Completed' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { selected: true })).not.toContainText('running');

  // "server": a background shell keeps running until it is stopped.
  await composer.fill('Start the dev server');
  await composer.press('Enter');
  const processes = activity.getByRole('list', { name: 'Processes' });
  const server = processes.getByRole('listitem').filter({ hasText: 'npm run dev' });
  await expect(server.getByRole('img', { name: 'Running' })).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toContainText('1 running');
  // The chat list row says so too (shown in its project, where it is among few chats).
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: /^proj-29( \d+)?$/ })
    .click();
  await expect(
    list.locator('[role="option"][data-session-id="session-979"]').getByText('1 running'),
  ).toBeVisible();
  // Ruling R29: its turn is over, but the dev server runs, so it is listed under Running.
  const row = list.locator('[role="option"][data-session-id="session-979"]');
  await expect(row.getByRole('img', { name: 'Idle' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: /^Running( \d+)?$/ })
    .click();
  await expect(row.getByText('1 running')).toBeVisible();
  await expect(row.getByRole('img', { name: 'Idle' })).toBeVisible();

  // Ctrl+. hides and shows the panel.
  await page.keyboard.press('Control+.');
  await expect(activity).toHaveCount(0);
  await page.keyboard.press('Control+.');
  await expect(activity).toBeVisible();

  await server.getByRole('button', { name: 'Stop npm run dev' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Stop process' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(server.getByRole('img', { name: 'Stopped' })).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).not.toContainText('running');
  // Nothing runs any more: it leaves Running.
  await expect(row).toHaveCount(0);

  // Clicking the agent shows the Agent call that started it.
  await agent.getByRole('button').click();
  await expect(page.locator('[data-row][data-flash]')).toContainText(
    'Explore the project structure',
  );
});

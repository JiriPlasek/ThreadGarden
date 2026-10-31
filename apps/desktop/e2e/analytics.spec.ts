import { expect, test } from '@playwright/test';
import { openApp, resetTabs } from './helpers';

test.beforeEach(async () => {
  await resetTabs();
});

test('Analytics: open from the places column, read a chart, filter to a project (v1.3 §4)', async ({
  page,
}) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });
  await places.getByRole('button', { name: 'Analytics' }).click();
  await expect(page.getByRole('tab', { name: 'Analytics', selected: true })).toBeVisible();

  // The mock's history is dated up to now: the last 30 days have chats.
  const view = page.getByRole('region', { name: 'Analytics' });
  const chats = view.locator('dt', { hasText: /^Chats$/ }).locator('+ dd');
  await expect(chats).not.toHaveText('0');
  for (const name of ['Activity', 'Output tokens by model', 'Top projects', 'When you work']) {
    await expect(view.getByRole('figure', { name })).toBeVisible();
  }

  // Keyboard: the activity chart reads out a day.
  const activity = view.getByRole('group', { name: /Messages and chats started per day/ });
  await activity.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(view.getByRole('figure', { name: 'Activity' }).locator('[aria-live]')).toContainText(
    /Messages \d/,
  );

  // The table view of the tools chart.
  const tools = view.getByRole('figure', { name: 'Tools used' });
  await tools.getByRole('button', { name: 'Show data' }).click();
  await expect(tools.getByRole('rowheader', { name: 'Read' })).toBeVisible();

  // A project bar filters everything to that project.
  const projects = view.getByRole('figure', { name: 'Top projects' });
  const bars = projects.getByRole('list', { name: 'Projects by messages' }).getByRole('button');
  const first = bars.first();
  const name = (await first.getAttribute('aria-label'))!.split(':')[0]!;
  await first.click();
  await expect(view.getByRole('combobox', { name: 'Project' })).toHaveValue(/proj-\d+/);
  await expect(bars).toHaveCount(1);
  await expect(
    view.getByRole('button', { name: new RegExp(`^${name}.*show all projects`) }),
  ).toBeVisible();

  // Ctrl/Cmd+W closes it like a chat tab.
  await page.keyboard.press('ControlOrMeta+w');
  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveCount(0);
});

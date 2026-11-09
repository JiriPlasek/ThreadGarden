import { expect, test } from '@playwright/test';
import { openApp, resetTabs, serviceCall } from './helpers';

test.afterEach(resetTabs);

test('an idle outside process always asks before stopping; Cancel preserves the chat', async ({
  page,
}) => {
  await serviceCall('uiState.set', {
    key: 'tabs',
    value: { open: ['session-0'], active: 'session-0' },
  });
  await openApp(page);
  const end = page.getByRole('button', { name: 'End the process', exact: true });
  await expect(end).toBeVisible();
  await end.click();
  const dialog = page.getByRole('alertdialog', { name: 'End the other process?' });
  await expect(dialog).toContainText('any running turn');
  await expect(dialog).toContainText('background tasks or a dev server');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(end).toBeVisible();
  // The mock pid is deliberately never signalled. Actual stop behavior is
  // covered by injected service/component tests and the isolated native probe.
});

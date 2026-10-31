import { expect, test } from '@playwright/test';
import { MOCK_CHATS, chatRow, openApp, resetTabs, serviceCall } from './helpers';

const CHAT = 'session-990';

test.beforeEach(resetTabs);

// The specs share the mock: whatever happens here, the chat ends up Active again
// (later specs count every chat under Active).
test.afterEach(async () => {
  await serviceCall('chat.setBucket', { sessionIds: [CHAT], bucket: 'active' });
});

test('archive a chat from its menu, find it in Archived, make it active again (v1.2 §3)', async ({
  page,
}) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });
  const list = page.getByRole('region', { name: 'Chat list' });
  const activeCount = places.locator('[title="Active chats"]');
  const archivedCount = places.locator('[title="Archived chats"]');
  const listed = list.locator(`[role="option"][data-session-id="${CHAT}"]`);
  await expect(archivedCount).toHaveCount(0);

  // Archive it from the row's context menu: it leaves Active.
  await (await chatRow(page, CHAT)).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(listed).toHaveCount(0);
  await expect(activeCount).toHaveText(String(MOCK_CHATS - 1));
  await expect(archivedCount).toHaveText('1');

  // Archived lists it, marked as archived.
  await places.getByRole('button', { name: /^Archived/ }).click();
  await expect(list.getByRole('heading', { name: 'Archived' })).toBeVisible();
  await expect(listed).toBeVisible();
  await expect(listed.getByRole('img', { name: 'Archived' })).toBeVisible();

  // A (chat list focused) makes the chat under the cursor active again.
  const box = list.getByRole('listbox');
  await box.focus();
  await box.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', `chat-row-${CHAT}`);
  await box.press('a');
  await expect(listed).toHaveCount(0);
  await expect(list.getByText('No archived chats.')).toBeVisible();
  await expect(archivedCount).toHaveCount(0);
  await expect(activeCount).toHaveText(String(MOCK_CHATS));

  // Back in Active.
  await places.getByRole('button', { name: /^Active/ }).click();
  await expect(await chatRow(page, CHAT)).toBeVisible();
});

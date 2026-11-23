import type { ChatSummary } from '@threadgarden/protocol';
import { expect, test } from '@playwright/test';
import { chatRow, markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

const OLDER = 'session-900';
const NEWER = 'session-901';

const summaries = async () =>
  (
    await serviceCall<{ items: ChatSummary[] }>('sessions.summaries', {
      sessionIds: [OLDER, NEWER],
    })
  ).items;

test.beforeEach(resetTabs);
test.afterEach(() => markAllSeen());

test('user sends move chats and projects while older tool progress keeps their sidebar order', async ({
  page,
}) => {
  await openApp(page);
  await (await chatRow(page, NEWER)).click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  const list = page.getByRole('region', { name: 'Chat list' });
  const places = page.getByRole('navigation', { name: 'Places' });
  const chatOrder = () =>
    list
      .locator(
        `[role="option"][data-session-id="${OLDER}"], [role="option"][data-session-id="${NEWER}"]`,
      )
      .evaluateAll((rows) => rows.slice(0, 2).map((row) => row.getAttribute('data-session-id')));
  const projectOrder = () =>
    places
      .getByRole('button', { name: /^proj-(0|1)( \d+)?$/ })
      .evaluateAll((rows) =>
        rows.slice(0, 2).map((row) => row.textContent?.trim().match(/^proj-\d+/)?.[0]),
      );

  // The agent scenario emits foreground and nested tool progress for several seconds.
  await (await chatRow(page, OLDER)).click();
  await composer.fill('Let an agent explore the code');
  await composer.press('Enter');
  await page.locator(`[role="tab"][data-tab="${NEWER}"]`).click();
  await list.getByRole('listbox').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(async () => (await chatOrder())[0]).toBe(OLDER);
  await expect.poll(async () => (await projectOrder())[0]).toBe('proj-0');
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'Permission request: Bash' })).toBeVisible();
  const sent = await summaries();
  expect(
    sent.find((chat) => chat.sessionId === NEWER)!.sortAt,
    JSON.stringify(sent),
  ).toBeGreaterThan(sent.find((chat) => chat.sessionId === OLDER)!.sortAt!);
  await expect.poll(chatOrder, { timeout: 1500, intervals: [50] }).toEqual([NEWER, OLDER]);
  await expect.poll(projectOrder).toEqual(['proj-1', 'proj-0']);

  const before = (await summaries()).find((chat) => chat.sessionId === OLDER)!;
  expect(before.status).toBe('working');
  expect(before.sortAt).toBeDefined();
  await expect
    .poll(
      async () => {
        const current = (await summaries()).find((chat) => chat.sessionId === OLDER)!;
        return current.lastActivity > before.lastActivity && current.status === 'working';
      },
      { intervals: [50], timeout: 2500 },
    )
    .toBe(true);
  const after = (await summaries()).find((chat) => chat.sessionId === OLDER)!;
  expect(after.sortAt).toBe(before.sortAt);
  await expect.poll(chatOrder).toEqual([NEWER, OLDER]);
  await expect.poll(projectOrder).toEqual(['proj-1', 'proj-0']);
  const row = list.locator(`[data-session-id="${OLDER}"]`);
  await expect(row.locator('time')).toHaveAttribute(
    'datetime',
    new Date(before.sortAt!).toISOString(),
  );
  const section = await row.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${section}"]`)).toHaveText('Last hour');
  // Let the waiting turn finish so the shared mock remains usable by later specs.
  await page
    .getByRole('group', { name: 'Permission request: Bash' })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
});

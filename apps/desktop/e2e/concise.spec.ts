import type { ChatItem } from '@threadgarden/protocol';
import { expect, test } from '@playwright/test';
import { chatRow, markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

const SID = 'session-998';

test.beforeEach(async () => {
  await resetTabs();
  await serviceCall('uiState.set', { key: 'chat.view', value: 'conversation' });
  await serviceCall('drafts.set', { key: SID, text: '' });
});
test.afterEach(async () => {
  await markAllSeen();
  await serviceCall('uiState.set', { key: 'chat.view', value: 'conversation' });
});

test('Concise hides tool noise, bounds long messages, preserves drafts and remembers the mode', async ({
  page,
}) => {
  const long = (label: string) =>
    Array.from({ length: 80 }, (_, index) => `${label} line ${index + 1}`).join('\n\n');
  const items: ChatItem[] = [
    { kind: 'user', id: 'long-user', ts: Date.now(), text: long('User request') },
    { kind: 'thinking', id: 'hidden-thought', text: 'PRIVATE THINKING FIXTURE' },
    {
      kind: 'toolCall',
      id: 'hidden-tool',
      toolUseId: 'fixture-tool',
      name: 'Read',
      input: { file_path: '/fixture/tool-noise.txt' },
      status: 'ok',
      parentToolUseId: null,
    },
    {
      kind: 'assistantText',
      id: 'long-reply',
      markdown: long('Assistant reply'),
      streaming: false,
    },
  ];
  // Only replace this chat's typed history response. Settings, drafts and all other RPCs use the mock service.
  await page.routeWebSocket(/127\.0\.0\.1/, (socket) => {
    const server = socket.connectToServer();
    const opens = new Set<number>();
    socket.onMessage((data) => {
      if (typeof data === 'string') {
        const request = JSON.parse(data);
        if (request.method === 'chat.open' && request.params.sessionId === SID)
          opens.add(request.id);
      }
      server.send(data);
    });
    server.onMessage((data) => {
      if (typeof data === 'string') {
        const response = JSON.parse(data);
        if (opens.delete(response.id) && response.result) {
          response.result = { ...response.result, items, tasks: [], hasMore: false };
          socket.send(JSON.stringify(response));
          return;
        }
      }
      socket.send(data);
    });
  });
  await openApp(page);
  await (await chatRow(page, SID)).click();
  const picker = page.getByRole('group', { name: 'Chat view', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Draft survives Concise');
  await picker.getByRole('button', { name: 'Concise', exact: true }).click();
  const messages = page.getByLabel('Messages', { exact: true });
  await expect(messages.locator('[data-item-id="hidden-tool"]')).toHaveCount(0);
  await expect(messages.locator('[data-item-id="hidden-thought"]')).toHaveCount(0);
  for (const id of ['long-reply', 'long-user']) {
    const row = messages.locator(`[data-row="${id}"]`);
    const block = row.locator('[data-concise-block]').first();
    const more = block.getByRole('button', { name: 'Show more', exact: true });
    await more.scrollIntoViewIfNeeded();
    await expect(more).toBeVisible();
    const clip = block.locator('[data-clamped-content]').locator('..');
    const cap = await clip.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
    expect(await clip.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(
      cap + 1,
    );
    await more.click();
    await expect(block.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
    expect(await clip.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(cap);
    await block.getByRole('button', { name: 'Show less', exact: true }).click();
  }
  await expect(composer).toHaveText('Draft survives Concise');
  await page.screenshot({ path: 'test-results/concise-draft.png' });
  await expect
    .poll(
      async () =>
        (await serviceCall<{ value: unknown }>('uiState.get', { key: 'chat.view' })).value,
    )
    .toBe('concise');
  await page.reload();
  await expect(picker.getByRole('button', { name: 'Concise', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(composer).toHaveText('Draft survives Concise');
});

test('Concise shows one finished live agent summary and keeps permission actions available', async ({
  page,
}) => {
  await openApp(page);
  await (await chatRow(page, SID)).click();
  await page
    .getByRole('group', { name: 'Chat view', exact: true })
    .getByRole('button', { name: 'Concise', exact: true })
    .click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Let an agent explore the code');
  await composer.press('Enter');
  const messages = page.getByLabel('Messages', { exact: true });
  const completed = messages
    .locator('[data-concise-task]')
    .filter({ hasText: 'Explore the project structure' });
  await expect(completed).toHaveCount(1, { timeout: 20_000 });
  await expect(completed).toContainText('Completed');
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');
  const request = page.getByRole('group', { name: 'Permission request: Bash' });
  await expect(request).toBeVisible();
  await request.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(
    page.getByText('There are three entries: README.md, package.json and src.'),
  ).toBeVisible();
  await expect(completed).toHaveCount(1);
});

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

test('Turns hides tool noise, bounds whole turns, preserves drafts and remembers the mode', async ({
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
    { kind: 'assistantText', id: 'second-reply', markdown: long('Second reply'), streaming: false },
    { kind: 'user', id: 'follow-up', ts: Date.now(), text: 'Next question' },
    { kind: 'assistantText', id: 'short-reply', markdown: 'Short answer', streaming: false },
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
  await composer.fill('Draft survives Turns');
  await picker.getByRole('button', { name: 'Turns', exact: true }).click();
  const messages = page.getByLabel('Messages', { exact: true });
  await expect(messages.locator('[data-item-id="hidden-tool"]')).toHaveCount(0);
  await expect(messages.locator('[data-item-id="hidden-thought"]')).toHaveCount(0);
  const turns = messages.locator('[data-concise-turn]');
  await expect(turns).toHaveCount(2);
  const first = turns.first();
  await expect(first.locator('[data-item-id="long-user"]')).toHaveCount(1);
  await expect(first.locator('[data-item-id="long-reply"]')).toHaveCount(1);
  await expect(first.locator('[data-item-id="second-reply"]')).toHaveCount(1);
  await expect(messages.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
  const scroll = first.locator('[data-turn-scroll]');
  const cap = await scroll.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
  const prompt = first.locator('[data-item-id="long-user"]');
  expect(await prompt.evaluate((el) => el.closest('[data-turn-scroll]') === null)).toBe(true);
  expect(await prompt.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(cap);
  await expect(prompt).toContainText('User request line 80');

  expect(await scroll.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(
    cap + 1,
  );
  await scroll.scrollIntoViewIfNeeded();
  await scroll.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const saved = await scroll.evaluate((el) => el.scrollTop);
  await picker.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(composer).toHaveText('Draft survives Turns');
  await picker.getByRole('button', { name: 'Turns', exact: true }).click();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(saved, 0);
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(first.getByText('Second reply line 80', { exact: false })).toBeInViewport();
  expect(await turns.last().evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(cap);
  await expect(composer).toBeHidden();
  await page.screenshot({ path: 'test-results/concise-draft.png' });
  await expect
    .poll(
      async () =>
        (await serviceCall<{ value: unknown }>('uiState.get', { key: 'chat.view' })).value,
    )
    .toBe('concise');
  await page.reload();
  await expect(picker.getByRole('button', { name: 'Turns', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(composer).toBeHidden();
  await picker.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(composer).toHaveText('Draft survives Turns');
});

test('Turns shows one finished live agent summary and keeps permission actions available', async ({
  page,
}) => {
  await openApp(page);
  await (await chatRow(page, SID)).click();
  const picker = page.getByRole('group', { name: 'Chat view', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Let an agent explore the code');
  await composer.press('Enter');
  await picker.getByRole('button', { name: 'Turns', exact: true }).click();
  await expect(composer).toBeHidden();
  const messages = page.getByLabel('Messages', { exact: true });
  const completed = messages
    .locator('[data-concise-task]')
    .filter({ hasText: 'Explore the project structure' });
  await expect(completed).toHaveCount(1, { timeout: 20_000 });
  await expect(completed).toContainText('Completed');
  await picker.getByRole('button', { name: 'Chat', exact: true }).click();
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');
  await picker.getByRole('button', { name: 'Turns', exact: true }).click();
  const request = page.getByRole('group', { name: 'Permission request: Bash' });
  await expect(request).toBeVisible();
  await request.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(
    page.getByText('There are three entries: README.md, package.json and src.'),
  ).toBeVisible();
  await expect(completed).toHaveCount(1);
});

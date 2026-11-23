import { expect, test } from '@playwright/test';
import type { ChatItem } from '@threadgarden/protocol';
import { chatRow, openApp, resetTabs } from './helpers';

test('Up and Down recall sent messages, Enter resends, and editing returns to normal arrow keys', async ({
  page,
}) => {
  await resetTabs();
  const items: ChatItem[] = [
    { kind: 'user', id: 'first', text: 'First request', ts: Date.now() - 1000 },
    { kind: 'assistantText', id: 'reply', markdown: 'First answer', streaming: false },
    { kind: 'user', id: 'last', text: 'Second request\nWith another line', ts: Date.now() },
  ];
  await page.routeWebSocket(/127\.0\.0\.1/, (socket) => {
    const server = socket.connectToServer();
    const opens = new Set<number>();
    socket.onMessage((data) => {
      if (typeof data === 'string') {
        const request = JSON.parse(data);
        if (request.method === 'chat.open' && request.params.sessionId === 'session-998')
          opens.add(request.id);
      }
      server.send(data);
    });
    server.onMessage((data) => {
      if (typeof data === 'string') {
        const response = JSON.parse(data);
        if (opens.delete(response.id) && response.result) {
          response.result = { ...response.result, items, hasMore: false };
          socket.send(JSON.stringify(response));
          return;
        }
      }
      socket.send(data);
    });
  });
  await openApp(page);
  await (await chatRow(page, 'session-998')).click();
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.press('ArrowUp');
  await expect(box).toHaveText('Second request\nWith another line');
  await box.press('ArrowUp');
  await expect(box).toHaveText('First request');
  await box.press('ArrowDown');
  await expect(box).toHaveText('Second request\nWith another line');
  await box.press('ArrowDown');
  await expect(box).toHaveText('');
  await box.press('ArrowUp');
  await box.press('ArrowUp');
  await box.press('Enter');
  await expect(box).toHaveText('');
  const messages = page.getByRole('region', { name: 'Messages', exact: true });
  await expect(messages.getByText('First request', { exact: true })).toHaveCount(2);
  await box.press('ArrowUp');
  await expect(box).toHaveText('First request');
  await page.keyboard.type(' edited');
  await box.press('ArrowUp');
  await box.press('ArrowDown');
  await expect(box).toHaveText('First request edited');
  await page.screenshot({ path: 'test-results/message-recall.png' });
});

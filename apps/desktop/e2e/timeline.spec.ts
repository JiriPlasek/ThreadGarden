import { expect, test } from '@playwright/test';
import { openApp, resetTabs, serviceCall } from './helpers';

test.beforeEach(async () => {
  await resetTabs();
  await serviceCall('uiState.set', { key: 'chat.view', value: 'conversation' });
});
test.afterEach(async () => {
  await serviceCall('uiState.set', { key: 'chat.view', value: 'conversation' });
});

test('timeline reads old turns through the service, inspects one, and remembers the selected view', async ({
  page,
}) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const picker = page.getByRole('group', { name: 'Chat view', exact: true });
  const timelineButton = picker.getByRole('button', { name: 'Timeline', exact: true });
  await expect(timelineButton).toHaveAttribute('aria-pressed', 'false');
  const titleBox = await page.locator('header h1').last().boundingBox();
  const viewBox = await timelineButton.boundingBox();
  expect(viewBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Keep this draft');
  await timelineButton.click();
  await expect(composer).toBeHidden();
  await picker.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(composer).toHaveText('Keep this draft');
  await timelineButton.click();
  const timeline = page.getByRole('region', { name: 'Chat timeline' });
  await expect(timeline).toBeVisible();
  const first = timeline.getByRole('button', { name: /^Turn:/ }).first();
  await expect(first).toBeVisible();
  await first.click();
  const details = page.getByRole('complementary', { name: 'Timeline details' });
  await expect(details).toBeVisible();
  await expect(details.locator('[data-item-id]').first()).toBeVisible();
  await details.getByRole('button', { name: 'Close timeline details' }).click();
  await expect(details).toBeHidden();
  await page.reload();
  await expect(picker.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Chat timeline' })).toBeVisible();
  await picker.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(timeline).toBeHidden();
});

test('calendar layout shows parallel agents, folded overnight time, zoom, and a block inspector', async ({
  page,
}) => {
  const minute = 60_000;
  const now = Date.now();
  const yesterday = now - 24 * 60 * minute;
  const defaults = { outcome: '', toolCount: 12, agentCount: 0, status: 'completed' };
  const blocks = [
    {
      ...defaults,
      id: 'turn:plan',
      kind: 'turn',
      title: 'Plan the billing migration',
      startedAt: yesterday,
      promptAt: yesterday,
      endedAt: yesterday + 15 * minute,
      agentCount: 2,
    },
    {
      ...defaults,
      id: 'turn:build',
      kind: 'turn',
      title: 'Implement the plan and run the tests',
      activity: {
        startedAt: yesterday + 30 * minute,
        endedAt: yesterday + 130 * minute,
        binMs: minute,
        bins: 'c' + '1'.repeat(49) + '2'.repeat(25) + '8'.repeat(25),
        prompts: 1,
        replies: 2,
        reasoning: 25,
        toolCalls: 2,
        longestTool: { name: 'Bash', durationMs: 49 * minute },
      },
      startedAt: yesterday + 30 * minute,
      promptAt: yesterday + 30 * minute,
      endedAt: yesterday + 130 * minute,
      outcome: 'Invoices and refunds are migrated. Webhook tests found an issue.',
      agentCount: 3,
    },
    {
      ...defaults,
      id: 'agent:invoices',
      kind: 'agent',
      title: 'Migrate invoices',
      tokens: 4700000,
      activity: {
        startedAt: yesterday + 35 * minute,
        endedAt: yesterday + 95 * minute,
        binMs: minute,
        bins: '4' + '1'.repeat(39) + '0'.repeat(10) + '2'.repeat(5) + 'c'.repeat(5),
        prompts: 3,
        replies: 4,
        reasoning: 7,
        toolCalls: 1,
        longestTool: { name: 'Bash', durationMs: 39 * minute },
      },
      startedAt: yesterday + 35 * minute,
      endedAt: yesterday + 95 * minute,
      model: 'sonnet',
    },
    {
      ...defaults,
      id: 'agent:refunds',
      kind: 'agent',
      title: 'Migrate refunds',
      startedAt: yesterday + 36 * minute,
      endedAt: yesterday + 115 * minute,
      model: 'sonnet',
    },
    {
      ...defaults,
      id: 'agent:webhooks',
      kind: 'agent',
      title: 'Check webhook compatibility',
      startedAt: yesterday + 40 * minute,
      endedAt: yesterday + 40 * minute + 5000,
      status: 'failed',
      model: 'haiku',
    },
    {
      ...defaults,
      id: 'turn:fix',
      kind: 'turn',
      title: 'Fix the webhook tests',
      startedAt: now - 40 * minute,
      promptAt: now - 40 * minute,
      endedAt: now - 10 * minute,
      outcome: 'All tests pass.',
    },
    { ...defaults, id: 'turn:undated', kind: 'turn', title: 'Undated legacy prompt' },
  ];
  await page.routeWebSocket(/127\.0\.0\.1/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((data) => {
      if (typeof data !== 'string') {
        server.send(data);
        return;
      }
      const request = JSON.parse(data);
      if (request.method === 'chat.timeline')
        socket.send(JSON.stringify({ id: request.id, result: { blocks } }));
      else if (request.method === 'chat.timelineDetail')
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              items: [
                {
                  kind: 'assistantText',
                  id: 'report',
                  markdown: 'The migration is ready for review. All tests pass.',
                  streaming: false,
                },
              ],
              hasMore: false,
            },
          }),
        );
      else server.send(data);
    });
    server.onMessage((message) => socket.send(message));
  });
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  await page
    .getByRole('group', { name: 'Chat view', exact: true })
    .getByRole('button', { name: 'Timeline', exact: true })
    .click();
  const timeline = page.getByRole('region', { name: 'Chat timeline' });
  await expect(timeline.getByText(/with no recorded activity/)).toBeVisible();
  await expect(timeline.getByRole('button', { name: /^Agent:/ })).toHaveCount(3);
  await expect(timeline.getByText(/Timing unavailable/)).toHaveCount(0);
  await expect(timeline.getByText('Undated legacy prompt')).toHaveCount(0);
  await expect(timeline.locator('[data-timeline-block-time]')).toHaveCount(3);
  await expect(timeline.getByText(/You ·|Short entries expanded for readability/)).toHaveCount(0);
  await expect(timeline.getByRole('button', { name: /Agent: Check webhook/ })).toContainText(
    'Check webhook compatibility',
  );
  await expect(timeline.getByRole('button', { name: /Agent: Migrate invoices/ })).toContainText(
    '4.7M tokens',
  );
  await expect(timeline.getByRole('button', { name: /Agent: Migrate invoices/ })).not.toContainText(
    'completed',
  );
  await expect(
    timeline.getByRole('button', { name: /Agent: Migrate invoices/ }).locator('canvas'),
  ).toHaveCount(1);
  await expect(timeline.getByRole('button', { name: /Agent: Migrate invoices/ })).toContainText(
    '3 prompts',
  );
  await expect(timeline.locator('canvas')).toHaveCount(2);
  const minuteMarks = await timeline
    .locator('[data-timeline-tick]')
    .evaluateAll((times) => times.map((t) => new Date(t.getAttribute('datetime')!).getMinutes()));
  expect(minuteMarks.length).toBeGreaterThan(0);
  expect(minuteMarks.every((m) => m % 15 === 0)).toBe(true);
  const legend = timeline.getByRole('group', { name: 'Color meanings', exact: true });
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Tool pending');
  const viewport = await timeline.locator('[data-timeline-scroll]').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { right: rect.left + el.clientWidth, bottom: rect.top + el.clientHeight };
  });
  const navigation = await timeline
    .getByRole('group', { name: 'Timeline navigation' })
    .boundingBox();
  expect(navigation!.x + navigation!.width).toBeLessThanOrEqual(viewport.right);
  expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(viewport.bottom);
  const legendBox = await legend.boundingBox();
  expect(legendBox!.y + legendBox!.height).toBeLessThanOrEqual(navigation!.y);
  expect(legendBox!.x + legendBox!.width).toBeLessThanOrEqual(viewport.right);
  await timeline.screenshot({ path: 'test-results/timeline-calendar.png' });
  await timeline.getByRole('button', { name: /Agent: Migrate invoices/ }).click();
  await expect(page.getByLabel('Recorded activity')).toContainText('Reasoning');
  await expect(page.getByLabel('Recorded activity')).toContainText('Bash');
  await expect(page.getByText('The migration is ready for review. All tests pass.')).toBeVisible();
  await page
    .getByRole('complementary', { name: 'Timeline details' })
    .screenshot({ path: 'test-results/timeline-inspector.png' });
  await page.getByRole('button', { name: 'Close timeline details' }).click();
  await timeline.getByRole('button', { name: 'Zoom in timeline' }).click();
  await expect(timeline.getByRole('group', { name: 'Timeline navigation' })).toHaveAttribute(
    'title',
    /4 px\/min/,
  );
});

test('timeline follows a live delegated turn through completion', async ({ page }) => {
  await openApp(page);
  await page
    .getByRole('region', { name: 'Chat list' })
    .locator('[data-session-id="session-998"]')
    .click();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('agent');
  await composer.press('Enter');
  await page
    .getByRole('group', { name: 'Chat view', exact: true })
    .getByRole('button', { name: 'Timeline', exact: true })
    .click();
  const timeline = page.getByRole('region', { name: 'Chat timeline' });
  await expect(timeline).toBeVisible();
  await expect(composer).toBeHidden();
  await expect(timeline.getByRole('button', { name: /^Agent:.*running/ }).first()).toBeVisible();
  await timeline.getByRole('button', { name: /^Turn: agent · running/ }).click();
  const details = page.getByRole('complementary', { name: 'Timeline details' });
  await expect(details).toBeVisible();
  await expect(timeline.getByRole('button', { name: /^Agent:.*completed/ }).first()).toBeVisible();
  await expect(timeline.getByRole('button', { name: /^Turn: agent · completed/ })).toBeVisible();
  await expect(details.getByText(/The subagent reports:/)).toBeVisible();
});

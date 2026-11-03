import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { chatRow, markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * Writes the README's pictures to docs/images/ from the mock build, which holds
 * only made-up data. Off unless THREADGARDEN_SCREENSHOTS=1, so normal runs and
 * CI never touch the files:
 *
 *   THREADGARDEN_SCREENSHOTS=1 pnpm --filter desktop test:e2e screenshots
 *
 * Look at every picture afterwards: nothing on show may come from your own
 * machine (a path, a name), and the captions in README.md must still fit.
 */
test.skip(process.env.THREADGARDEN_SCREENSHOTS !== '1', 'set THREADGARDEN_SCREENSHOTS=1');

const OUT = fileURLToPath(new URL('../../../docs/images/', import.meta.url));
const MACHINE = 'Ubuntu';
const LATEST = '0.99.0';

test.use({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });

/** Forgets every paired machine, so the specs after this one see This PC only. */
const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

const reset = async (): Promise<void> => {
  await remoteCall('mock.resetUpdate', {});
  await serviceCall('mock.forgetMoves', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
};

test.beforeEach(reset);
test.afterEach(reset);

const shot = async (target: Page | Locator, name: string): Promise<void> => {
  await target.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled' });
};

/** Settings → Machines → Add machine… with the remote mock's code; leaves Settings open. */
const pairUbuntu = async (page: Page): Promise<void> => {
  const places = page.getByRole('navigation', { name: 'Places' });
  await places.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Add machine…' }).click();
  const add = page.getByRole('dialog', { name: 'Add machine' });
  await add.getByLabel('Address').fill('127.0.0.1');
  await add.getByText('More').click();
  await add.getByLabel('Port').fill(String(REMOTE_MOCK_PORT));
  await add.getByLabel('Pairing code').fill(REMOTE_PAIRING_CODE);
  await add.getByRole('button', { name: 'Pair' }).click();
  await expect(add).toBeHidden();
  await expect(
    settings.getByRole('group', { name: MACHINE }).getByText('On', { exact: true }),
  ).toBeVisible();
};

test('the pictures', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });
  const composer = page.getByRole('textbox', { name: 'Message' });
  // A chat that ran a command: the permission asked, allowed, the output shown.
  await (await chatRow(page, 'session-998')).click();
  // The Activity panel is empty here; the pictures are better without it. Put back at the end.
  await page.getByRole('button', { name: 'Activity panel' }).click();
  await expect(page.locator('[aria-label="Activity"]')).toBeHidden();
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');
  const request = page.getByRole('group', { name: 'Permission request: Bash' });
  await expect(request).toBeVisible();
  await request.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(
    page.getByText('There are three entries: README.md, package.json and src.'),
  ).toBeVisible();
  await expect(page.getByRole('tab', { selected: true }).locator('[data-status]')).toHaveAttribute(
    'data-status',
    /^(idle|yourTurn)$/,
  );
  await page.mouse.move(0, 0);
  await shot(page, 'main-window');

  // Another chat waiting for an answer, under Needs you.
  await (await chatRow(page, 'session-997')).click();
  await composer.fill('Please list the files, perm needed');
  await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'Permission request: Bash' })).toBeVisible();
  await places.getByRole('button', { name: /Needs you/ }).click();
  await expect(page.getByRole('region', { name: 'Chat list' }).getByRole('option')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await shot(page, 'needs-you');

  // Settings → Machines with a machine that is behind.
  await resetTabs();
  await page.reload();
  await pairUbuntu(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const card = settings.getByRole('group', { name: MACHINE });
  await expect(
    card.getByRole('button', { name: `Update to ${LATEST} on ${MACHINE}` }),
  ).toBeVisible();
  // Just the Machines section, from its heading to the Add machine… button.
  const heading = settings.getByText('Machines', { exact: true });
  await heading.scrollIntoViewIfNeeded();
  const add = settings.getByRole('button', { name: 'Add machine…' });
  await add.scrollIntoViewIfNeeded();
  const [d, h, a] = [settings, heading, add].map((l) => l.boundingBox());
  const [dBox, hBox, aBox] = (await Promise.all([d, h, a])) as NonNullable<
    Awaited<ReturnType<Locator['boundingBox']>>
  >[];
  await page.screenshot({
    path: `${OUT}settings-machines.png`,
    animations: 'disabled',
    clip: {
      x: dBox.x,
      y: Math.max(dBox.y, hBox.y - 14),
      width: dBox.width,
      height:
        Math.min(aBox.y + aBox.height + 14, dBox.y + dBox.height) - Math.max(dBox.y, hBox.y - 14),
    },
  });
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // Move to…, with its checks passed.
  await places.getByRole('button', { name: /^Active/ }).click();
  await (await chatRow(page, 'session-995')).click();
  await page.getByRole('button', { name: 'Chat state' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const move = page.getByRole('dialog', { name: 'Move this chat' });
  await expect(move.getByLabel('Machine').locator('option:checked')).toHaveText(MACHINE);
  await expect(move.getByText("The chat isn't busy.")).toBeVisible();
  await expect(move.getByText(/^The project is clean/)).toBeVisible();
  await expect(move.getByText(`${MACHINE} is on.`)).toBeVisible();
  // The mock's Ubuntu keeps its folders in this PC's temp directory, which names the user.
  // Show the folder a real Ubuntu PC would offer the first time (docs/remote-machines.md).
  await move
    .locator('[title]')
    .filter({ hasText: /threadgarden/i })
    .first()
    .evaluate((el) => {
      el.textContent = '~/threadgarden/projects/proj-45';
    });
  await shot(move, 'move-chat');
  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();

  // Usage per account.
  const meter = page.getByRole('button', { name: /^Usage: .*5-hour limit/ }).first();
  await meter.click();
  const usage = page.getByRole('dialog', { name: 'Usage' });
  await expect(usage.getByRole('meter', { name: 'Weekly limit used' }).first()).toBeVisible();
  await shot(usage, 'usage');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Activity panel' }).click();
});

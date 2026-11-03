import { expect, test, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * Updating a machine from Settings (protocol 10) end to end: This PC (the mock
 * service) pairs with the headless mock "Ubuntu", which is behind the release
 * the main mock offers (0.99.0), and updates it. The remote mock only pretends
 * (stages 300 ms apart, then a pretend restart that changes its version), and
 * keeps that version for the rest of the run, so each test resets it.
 */
const MACHINE = 'Ubuntu';
const LATEST = '0.99.0';
const UPDATE_BUTTON = `Update to ${LATEST} on ${MACHINE}`;

/** Forgets every paired machine, so the specs after this one see This PC only. */
const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

test.beforeEach(async () => {
  await remoteCall('mock.resetUpdate', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  // The pretend update changed the remote mock's version and status for the rest of the run.
  await remoteCall('mock.resetUpdate', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

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

test("Settings shows Ubuntu's version, the dot, and Update to 0.99.0", async ({ page }) => {
  await openApp(page);
  await pairUbuntu(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const card = settings.getByRole('group', { name: MACHINE });
  await expect(card.getByText(/^Threadgarden \d+\.\d+\.\d+$/)).toBeVisible();
  await expect(card.getByText(`· ${LATEST} available`)).toBeVisible();
  await expect(card.getByRole('button', { name: UPDATE_BUTTON })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  // The dot on the Settings button in Places.
  await expect(
    page
      .getByRole('navigation', { name: 'Places' })
      .getByRole('button', { name: 'Settings (a machine update is available)' }),
  ).toBeVisible();
});

test('busy asks first', async ({ page }) => {
  await openApp(page);
  await pairUbuntu(page);
  await remoteCall('mock.setBusy', { count: 1 });
  const card = page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: MACHINE });
  await card.getByRole('button', { name: UPDATE_BUTTON }).click();
  const ask = page.getByRole('alertdialog', { name: `Update ${MACHINE} now?` });
  await expect(ask).toContainText(`Claude is working in 1 chat on ${MACHINE}`);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  // Nothing started: no stage, no result, the button is still there.
  await expect(card.getByRole('status')).toHaveCount(0);
  await expect(card.getByRole('button', { name: UPDATE_BUTTON })).toBeVisible();
});

test('updating shows the stages and ends with Threadgarden 0.99.0 ✓ and no dot', async ({
  page,
}) => {
  await openApp(page);
  await pairUbuntu(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const card = settings.getByRole('group', { name: MACHINE });
  await card.getByRole('button', { name: UPDATE_BUTTON }).click();
  await expect(card.getByRole('status')).toHaveText(`Downloading ${LATEST}…`);
  await expect(card.getByRole('status')).toHaveText(`Threadgarden ${LATEST} ✓`);
  await expect(card.getByText(`Threadgarden ${LATEST}`, { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: /^Update to / })).toHaveCount(0);
  await expect(card.getByText(/available$/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(
    page
      .getByRole('navigation', { name: 'Places' })
      .getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
});

test('a checksum failure shows its line', async ({ page }) => {
  await openApp(page);
  await pairUbuntu(page);
  await remoteCall('mock.failNextUpdate', { reason: 'checksum' });
  const card = page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: MACHINE });
  await card.getByRole('button', { name: UPDATE_BUTTON }).click();
  await expect(card.getByRole('alert')).toHaveText("The download's checksum didn't match");
  // Still behind: it can be tried again.
  await expect(card.getByRole('button', { name: UPDATE_BUTTON })).toBeEnabled();
});

test("a 40-character unbroken machine name doesn't widen Settings or overflow the card", async ({
  page,
}) => {
  const name = 'Z'.repeat(40);
  await openApp(page);
  await pairUbuntu(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('group', { name: MACHINE }).getByLabel('Name').fill(name);
  await settings.getByRole('button', { name: `Save ${MACHINE}` }).click();
  const card = settings.getByRole('group', { name });
  await expect(card).toBeVisible();
  const widthBefore = (await settings.boundingBox())!.width;

  // An install failure's line names the machine and the version it fell back to.
  await remoteCall('mock.failNextUpdate', { reason: 'install' });
  await card.getByRole('button', { name: `Update to ${LATEST} on ${name}` }).click();
  const line = card.getByRole('alert');
  await expect(line).toContainText(name);

  expect((await settings.boundingBox())!.width).toBe(widthBefore);
  expect(await settings.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(0);
  const cardBox = (await card.boundingBox())!;
  const lineBox = (await line.boundingBox())!;
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
});

import { expect, test } from '@playwright/test';
import {
  FAKE_PLUG,
  FAKE_SWITCH_PASSWORD,
  FAKE_SWITCH_PORT,
  REMOTE_MOCK_PORT,
  REMOTE_PAIRING_CODE,
} from './env';
import { markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

/**
 * Power control (plan 4) end to end: This PC pairs with the headless mock
 * "Ubuntu" (which offers the `power` capability), then Settings → Machines →
 * Power → Set up power control… connects to the fake Tasmota Zigbee bridge the
 * remote mock started (`--fake-tasmota`), chooses its plug `MockPlug` and
 * saves. The machine's heading then has its ⏻ button and the Power section
 * shows the plug's 47 W.
 */
const MACHINE = 'Ubuntu';

/** Forgets every paired machine (and so its power control), so the other specs see This PC only. */
const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

test.beforeEach(async () => {
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  await forgetMachines();
  await resetTabs();
});

test('set up power control against a fake switch: the ⏻ button and the plug’s watts', async ({
  page,
}) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });

  // Pair the remote mock (Settings → Machines → Add machine…).
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
  const entry = settings.getByRole('group', { name: MACHINE });
  await expect(entry.getByText('On', { exact: true })).toBeVisible();

  // Power → Set up power control…: Connect, Choose the plug, Check, Save.
  const power = entry.getByRole('group', { name: 'Power control' });
  await power.getByRole('button', { name: 'Set up power control…' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up power control' });
  await expect(setup).toBeVisible();

  // A wrong password is refused, in words.
  await setup.getByLabel('Address').fill(`127.0.0.1:${FAKE_SWITCH_PORT}`);
  await setup.getByLabel('Password').fill('not-the-password');
  await setup.getByRole('button', { name: 'Connect' }).click();
  await expect(setup.getByRole('alert')).toHaveText("The switch didn't accept that password.");
  await expect(setup.getByRole('heading', { name: 'Connect' })).toBeVisible();

  await setup.getByLabel('Password').fill(FAKE_SWITCH_PASSWORD);
  await setup.getByRole('button', { name: 'Connect' }).click();
  await expect(setup.getByRole('heading', { name: 'Choose the plug' })).toBeFocused();
  await setup.getByRole('radio', { name: new RegExp(`^${FAKE_PLUG} — 47 W`) }).check();
  await setup.getByRole('button', { name: 'Next' }).click();

  await expect(setup.getByRole('heading', { name: 'Check' })).toBeVisible();
  await expect(setup.getByText('Now drawing 47 W')).toBeVisible();
  await expect(setup.getByLabel('Off below (W)')).toHaveValue('5');
  await expect(setup.getByLabel('Wait before switching on (s)')).toHaveValue('90');
  await setup.getByRole('button', { name: 'Save' }).click();
  await expect(setup).toBeHidden();

  // The Power section shows the plug and its reading.
  await expect(power.getByText(FAKE_PLUG, { exact: true })).toBeVisible();
  await expect(power.getByText('47 W', { exact: true })).toBeVisible();
  await expect(power.getByLabel('Shut down after idle')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // The machine's heading has the ⏻ menu; Turn on is not offered while it is On.
  const heading = places.getByRole('group', { name: MACHINE });
  const menu = heading.getByRole('button', { name: `Power for ${MACHINE}` });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('menuitem', { name: 'Shut down now' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Turn on' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

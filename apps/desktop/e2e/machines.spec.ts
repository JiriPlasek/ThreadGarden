import { expect, test } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { chatRow, markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

/**
 * Remote machines (v1.4) end to end: This PC (the mock service) pairs with a
 * second, headless mock service (`mock --remote`: the machine "Ubuntu", 20
 * chats in the project `tg-cli`) over its TLS device listener on
 * 127.0.0.1, with the pairing code it keeps live, then reaches it through
 * This PC's relay. The UI drives it all from Settings → Machines, its
 * dialogs nested over Settings.
 */
const MACHINE = 'Ubuntu';
/** The remote mock's newest chat (its corpus uses the same ids as This PC's: they stay apart). */
const REMOTE_CHAT = 'session-19';

/** Forgets every paired machine, so the specs after this one see This PC only. */
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

test('pair with a second machine, chat on it, see its Needs you item, remove it', async ({
  page,
}) => {
  await openApp(page);
  const places = page.getByRole('navigation', { name: 'Places' });
  const list = page.getByRole('region', { name: 'Chat list' });

  // Settings → Machines → Add machine…: a dialog over the Settings dialog.
  await places.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  const addMachine = settings.getByRole('button', { name: 'Add machine…' });
  await addMachine.click();
  const add = page.getByRole('dialog', { name: 'Add machine' });
  await expect(add).toBeVisible();

  // Escape closes the top dialog only; focus goes back to the button that opened it,
  // and what was typed (a code, maybe) is gone when the dialog opens again.
  await add.getByLabel('Address').fill('127.0.0.1');
  await page.keyboard.press('Escape');
  await expect(add).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(addMachine).toBeFocused();
  await addMachine.click();
  await expect(add.getByLabel('Address')).toHaveValue('');

  // A code the machine does not show: it cannot prove it knows it, so nothing is sent.
  await add.getByLabel('Address').fill('127.0.0.1');
  await add.getByText('More').click();
  await add.getByLabel('Port').fill(String(REMOTE_MOCK_PORT));
  await add.getByLabel('Pairing code').fill('AAAA-BBBB-CCCC');
  await expect(add.getByLabel("This device's name")).not.toHaveValue('');
  await add.getByRole('button', { name: 'Pair' }).click();
  await expect(add.getByRole('alert')).toContainText("couldn't prove it knows this code");

  // The code `threadgarden pair` shows there: paired, the dialog closes, the machine is On.
  await add.getByLabel('Pairing code').fill(REMOTE_PAIRING_CODE);
  await add.getByRole('button', { name: 'Pair' }).click();
  await expect(add).toBeHidden();
  await expect(settings).toBeVisible();
  const entry = settings.getByRole('group', { name: MACHINE });
  await expect(entry.getByText('On', { exact: true })).toBeVisible();
  await expect(entry.getByLabel('Address')).toHaveValue('127.0.0.1');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // The places column groups projects by machine: This PC, then Ubuntu with tg-cli.
  await expect(places.getByRole('group', { name: 'This PC' })).toBeVisible();
  const ubuntu = places.getByRole('group', { name: MACHINE });
  await expect(ubuntu.getByText('On', { exact: true })).toBeVisible();
  await ubuntu.getByRole('button', { name: 'tg-cli' }).click();
  await expect(list.locator('[role="option"][data-session-id]').first()).toBeVisible();

  // Open a chat there: its header names the machine; a message gets the scripted reply.
  await (await chatRow(page, REMOTE_CHAT)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', REMOTE_CHAT);
  await expect(page.getByTitle(`Runs on ${MACHINE}`)).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Hello from This PC');
  await composer.press('Enter');
  await expect(page.getByText('This is the Threadgarden mock service answering.')).toBeVisible();

  // A permission request there is a Needs you item here, with its machine chip.
  await composer.fill('List the files, perm needed');
  await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'Permission request: Bash' })).toBeVisible();
  await expect(places.locator('[title="Waiting for you"]')).toHaveText('1');
  await places.getByRole('button', { name: /Needs you/ }).click();
  const waiting = list.locator('[role="option"][data-session-id]');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toHaveAttribute('data-session-id', REMOTE_CHAT);
  await expect(waiting.getByText(MACHINE, { exact: true })).toBeVisible();

  // Settings → Machines → Remove: a confirmation over Settings; Escape closes it only.
  await places.getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  const remove = settings.getByRole('button', { name: `Remove ${MACHINE}` });
  await remove.click();
  const confirm = page.getByRole('alertdialog', { name: `Remove ${MACHINE}?` });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(remove).toBeFocused();

  // Confirmed: the machine is reachable, so it forgets this PC too (no notice); focus stays in Settings.
  await remove.click();
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(settings.getByRole('group', { name: MACHINE })).toHaveCount(0);
  await expect(settings.getByText("couldn't be reached")).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: 'Machines' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // Back to This PC alone: no machine groups, nothing waiting.
  await expect(places.getByRole('group', { name: MACHINE })).toHaveCount(0);
  await expect(places.locator('[title="Waiting for you"]')).toHaveCount(0);
  expect(await serviceCall<unknown[]>('machines.list', {})).toEqual([]);
});

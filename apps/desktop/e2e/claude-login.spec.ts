import { expect, test, type Locator, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { chatRow, markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * Signing in to Claude (protocol 14) end to end, against the mock's fake
 * sign-in: This PC's mock is signed in as mock@example.com (Max), the remote
 * mock ("Ubuntu") starts with its sign-in expired, so its `session-2` fails on
 * login (a chat no other spec uses). Both hand out the same fake link and take
 * `MOCK-CODE` (signed in as other@example.com, Pro); any other code is refused
 * and ends the sign-in. `mock.claudeLoginReset` puts a mock back to its start.
 * The phone's check is in phone.spec.ts (it needs the phone's UI build).
 */
const MACHINE = 'Ubuntu';
/** The remote mock's chat that fails on login while its sign-in is expired. */
const REMOTE_CHAT = 'session-2';
/** A This PC chat no other spec opens. */
const LOCAL_CHAT = 'session-550';
const REPLY = 'This is the Threadgarden mock service answering.';
const LINK = 'https://claude.ai/oauth/authorize?mock=1';
const CODE = 'MOCK-CODE';

const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

/** Both mocks back to their start: This PC signed in, Ubuntu expired, no sign-in open. */
const resetSignIns = async (): Promise<void> => {
  await serviceCall('mock.claudeLoginReset', {});
  await remoteCall('mock.claudeLoginReset', {});
};

test.beforeEach(async () => {
  await forgetMachines();
  await resetSignIns();
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  await resetSignIns();
  await remoteCall('chat.end', { sessionId: REMOTE_CHAT }).catch(() => undefined);
  await markAllSeen(remoteCall);
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const signInDialog = (page: Page, machine: string): Locator =>
  page.getByRole('dialog', { name: `Sign in to Claude (${machine})` });

const openSettings = async (page: Page): Promise<Locator> => {
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  return settings;
};

/** Settings → Machines → Add machine… with the remote mock's code (as mcp.spec.ts). */
const pairUbuntu = async (page: Page): Promise<void> => {
  const settings = await openSettings(page);
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
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** Sends `text`; a chat changed seconds ago may ask Continue this chat here? first. */
const send = async (page: Page, text: string): Promise<void> => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  const ask = page.getByRole('alertdialog', { name: 'Continue this chat here?' });
  if (
    await ask.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await ask.getByRole('button', { name: 'Continue here' }).click();
  }
};

/** In an open sign-in dialog: the link shows, the code goes in, and it closes signed in. */
const signInWithCode = async (dialog: Locator): Promise<void> => {
  await expect(dialog.getByText('Open this link and approve:')).toBeVisible();
  await expect(dialog.getByTestId('claude-sign-in-link')).toHaveText(LINK);
  await dialog.getByLabel('Paste the code claude.ai shows you').fill(CODE);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Signed in as other@example.com.');
  await expect(dialog).toBeHidden();
};

test("Settings shows This PC's account and switches it with the mock code", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page);
  const row = settings.getByRole('group', { name: 'Claude account on This PC' });
  await expect(row).toContainText('mock@example.com · Max');

  await row.getByRole('button', { name: 'Switch account' }).click();
  const dialog = signInDialog(page, 'This PC');
  await expect(dialog.getByTestId('claude-sign-in-link')).toHaveText(LINK);
  // A wrong code ends that sign-in (as Claude Code's does): the dialog offers a fresh one.
  await dialog.getByLabel('Paste the code claude.ai shows you').fill('NOT-THE-CODE');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Invalid code');
  await dialog.getByRole('button', { name: 'Start again' }).click();
  await signInWithCode(dialog);

  await expect(row).toContainText('other@example.com · Pro');
  await expect(row.getByRole('button', { name: 'Switch account' })).toBeVisible();
  // The code never stays on the page.
  expect(await page.content()).not.toContain(CODE);
});

test("a paired machine's expired chat offers Sign in to Claude, and signing in lets it answer", async ({
  page,
}) => {
  await remoteCall('chat.end', { sessionId: REMOTE_CHAT });
  await openApp(page);
  await pairUbuntu(page);
  // Settings already knows it expired (the machine said so when it came on).
  const before = await openSettings(page);
  const ubuntuRow = before.getByRole('group', { name: `Claude account on ${MACHINE}` });
  await expect(ubuntuRow).toContainText('Sign-in expired');
  await expect(ubuntuRow.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(before).toBeHidden();
  // From Ubuntu's tg-cli: This PC has a session-2 too.
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('group', { name: MACHINE })
    .getByRole('button', { name: 'tg-cli' })
    .click();
  await (await chatRow(page, REMOTE_CHAT)).click();
  await expect(page.getByTitle(`Runs on ${MACHINE}`)).toBeVisible();

  await send(page, 'Hello from the sign-in test');
  await expect(
    page.getByText(`Claude Code isn't signed in on ${MACHINE}, or its sign-in expired.`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to Claude' }).click();
  await signInWithCode(signInDialog(page, MACHINE));

  // Settings says so too.
  const settings = await openSettings(page);
  await expect(settings.getByRole('group', { name: `Claude account on ${MACHINE}` })).toContainText(
    'other@example.com · Pro',
  );
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await send(page, 'Hello again from the sign-in test');
  await expect(page.getByText(REPLY).first()).toBeVisible();
});

test('/login opens the sign-in', async ({ page }) => {
  await openApp(page);
  await (await chatRow(page, LOCAL_CHAT)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', LOCAL_CHAT);
  await composer(page).fill('/login');
  await composer(page).press('Enter');
  const dialog = signInDialog(page, 'This PC');
  await expect(dialog.getByTestId('claude-sign-in-link')).toHaveText(LINK);
  // Not sent to Claude: nothing new in the chat.
  await expect(page.getByText('/login', { exact: true })).toHaveCount(0);
  // Cancel closes it and ends the sign-in on the machine.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await serviceCall<{ signingIn: boolean }>('claude.account', {})).signingIn)
    .toBe(false);
});

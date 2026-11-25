import { expect, test, type Locator, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { chatRow, markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * `!` commands in the chat (protocol 13) end to end, against the mock: both
 * mocks run a command in a fake terminal (`mock-pty.ts`: `sudo …` asks for a
 * password, then `[Y/n]`; `sleep N`; `ignore-int`; `flood`; `exit N`; `ls`).
 * The phone layout's check is in phone.spec.ts (it needs the phone's UI build).
 */
/** This PC chats in `proj-0` that no other spec opens (every 50th session is one). */
const CHATS = [
  'session-850',
  'session-800',
  'session-750',
  'session-700',
  'session-650',
  'session-600',
];
/** The remote mock's newest chat (as mcp.spec.ts), reached through This PC's relay. */
const REMOTE_CHAT = 'session-19';
const REPLY = 'This is the Threadgarden mock service answering.';
const SUDO_INPUT = 'typed-blind-not-for-claude';

test.beforeEach(async () => {
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  // A command still running ends with its session (`chat.end` also ends the mock's tab).
  for (const id of CHATS) await serviceCall('chat.end', { sessionId: id }).catch(() => undefined);
  await resetTabs();
  await markAllSeen();
});

const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const block = (page: Page): Locator => page.locator('[data-shell-block]');

/** Opens a This PC chat from the list and makes it live with one message. */
const openLiveChat = async (page: Page, sessionId: string): Promise<void> => {
  await openApp(page);
  await (await chatRow(page, sessionId)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', sessionId);
  await composer(page).fill('Hello from the shell test');
  await composer(page).press('Enter');
  await expect(page.getByText(REPLY).first()).toBeVisible();
};

const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

/** Settings → Machines → Add machine… with the remote mock's code (as mcp.spec.ts). */
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
    settings.getByRole('group', { name: 'Ubuntu' }).getByText('On', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** How often `text` shows in the block's terminal (its drawn rows, not the title). */
const timesShown = async (page: Page, text: string): Promise<number> =>
  (await block(page).locator('.xterm-rows').innerText()).split(text).length - 1;

/**
 * `text` shows exactly once in the block's terminal, and still does two frames
 * later: by then a write still queued in the terminal has been drawn.
 */
const expectShownOnce = async (page: Page, text: string): Promise<void> => {
  await expect.poll(() => timesShown(page, text)).toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(await timesShown(page, text)).toBe(1);
};

const run = async (page: Page, command: string): Promise<void> => {
  await composer(page).fill(`! ${command}`);
  await composer(page).press('Enter');
  await expect(block(page)).toBeVisible();
};

test('! sudo apt upgrade takes a password and y, and ends with exit 0', async ({ page }) => {
  await openLiveChat(page, CHATS[0]!);
  await run(page, 'sudo apt upgrade');
  await expect(block(page)).toContainText('[sudo] password for mock:');
  // The block has the keyboard: the password is typed blind (no echo).
  await page.keyboard.type(SUDO_INPUT);
  await page.keyboard.press('Enter');
  await expect(block(page)).toContainText('Do you want to continue? [Y/n]');
  await page.keyboard.type('y');
  await page.keyboard.press('Enter');
  await expect(block(page)).toContainText('✓ exit 0 ·');
  await expect(block(page)).toContainText('Done.');
  // The command line and its output are in the chat (the block sits after the line).
  await expect(page.getByText('! sudo apt upgrade', { exact: true })).toBeVisible();
  await expect(page.getByText(SUDO_INPUT)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(SUDO_INPUT);

  // After a reload the chat comes back from the transcript: the password isn't in it.
  await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', CHATS[0]!);
  await expect(page.getByText('! sudo apt upgrade', { exact: true })).toBeVisible();
  await expect(page.getByText(/Reading package lists/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SUDO_INPUT);
});

test('the next message carries the output to Claude', async ({ page }) => {
  await openLiveChat(page, CHATS[1]!);
  await run(page, 'ls');
  await expect(block(page)).toContainText('✓ exit 0 ·');
  await expectShownOnce(page, 'package.json');
  await composer(page).fill('What do you see?');
  await composer(page).press('Enter');
  await expect(page.getByText(/I can see the output of/)).toBeVisible();
});

test('Stop ends a sleeping command', async ({ page }) => {
  await openLiveChat(page, CHATS[2]!);
  await run(page, 'sleep 60');
  await expect(block(page)).toContainText('Running ·');
  await block(page).getByRole('button', { name: 'Stop' }).click();
  await expect(block(page)).toContainText('Stopped ·');
  await expect(block(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
});

test('Stop kills a command that ignores Ctrl-C after the grace period', async ({ page }) => {
  await openLiveChat(page, CHATS[5]!);
  await run(page, 'ignore-int');
  await expect(block(page)).toContainText('Ctrl-C does nothing here');
  const started = Date.now();
  await block(page).getByRole('button', { name: 'Stop' }).click();
  await expect(block(page)).toContainText('Stopped ·', { timeout: 20_000 });
  // It was asked politely first: not killed at once.
  expect(Date.now() - started).toBeGreaterThan(1_000);
});

test('a command keeps running when its tab closes and redraws when reopened', async ({ page }) => {
  await openLiveChat(page, CHATS[3]!);
  await run(page, 'sudo apt upgrade');
  await expect(block(page)).toContainText('[sudo] password for mock:');
  await page
    .getByRole('button', { name: /^Close / })
    .first()
    .click();
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(0);
  await page
    .getByRole('region', { name: 'Chat list' })
    .getByRole('listbox')
    .evaluate((el) => (el.scrollTop = 0));
  await (await chatRow(page, CHATS[3]!)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', CHATS[3]!);
  await expect(block(page)).toBeVisible();
  await expect(block(page)).toContainText('[sudo] password for mock:');
  await expect(block(page)).toContainText('Running ·');
  // Still answering (a reopened block has no focus until clicked): finish it.
  await block(page).locator('[data-terminal]').click();
  await page.keyboard.type(SUDO_INPUT);
  await page.keyboard.press('Enter');
  await expect(block(page)).toContainText('Do you want to continue? [Y/n]');
  await page.keyboard.type('n');
  await page.keyboard.press('Enter');
  await expect(block(page)).toContainText('✗ exit 1 ·');
});

test('a flood stays responsive', async ({ page }) => {
  await openLiveChat(page, CHATS[4]!);
  await run(page, 'flood');
  await composer(page).click();
  await composer(page).pressSequentially('still typing', { delay: 20 });
  await expect(composer(page)).toContainText('still typing');
  await expect(block(page)).toContainText('✓ exit 0 ·', { timeout: 45_000 });
  await expect(block(page)).toContainText('output skipped here');
});

test('a command on a paired machine shows its output once, live', async ({ page }) => {
  await forgetMachines();
  try {
    await openApp(page);
    await pairUbuntu(page);
    await (await chatRow(page, REMOTE_CHAT)).click();
    await expect(page.getByTitle('Runs on Ubuntu')).toBeVisible();
    await composer(page).fill('Hello from the shell test');
    await composer(page).press('Enter');
    await expect(page.getByText(REPLY).first()).toBeVisible();

    await run(page, 'echo hi');
    await expect(block(page)).toContainText('✓ exit 0 ·');
    await expectShownOnce(page, 'mock: echo hi');
  } finally {
    await remoteCall('chat.end', { sessionId: REMOTE_CHAT }).catch(() => undefined);
    await markAllSeen(remoteCall);
    await forgetMachines();
  }
});

// On the paired machine: a chat made on This PC would stay in its history and change the
// Active count every later spec's `openApp` waits for; forgetting Ubuntu drops this one.
test('New chat sends ! as text', async ({ page }) => {
  await forgetMachines();
  let sessionId: string | undefined;
  try {
    await openApp(page);
    await pairUbuntu(page);
    const places = page.getByRole('navigation', { name: 'Places' });
    await places
      .getByRole('group', { name: 'Ubuntu' })
      .getByRole('button', { name: 'tg-cli' })
      .click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New chat', exact: true });
    await expect(
      dialog.getByRole('combobox', { name: 'Machine' }).locator('option:checked'),
    ).toHaveText(/^Ubuntu/);
    await dialog.getByRole('textbox', { name: 'First message' }).fill('! ls');
    await dialog.getByRole('textbox', { name: 'First message' }).press('Enter');
    await expect(dialog).toBeHidden();
    const key = await page.getByRole('tab', { selected: true }).getAttribute('data-chat-key');
    sessionId = key?.slice(key.indexOf('/') + 1);
    await expect(page.getByTitle('Runs on Ubuntu')).toBeVisible();
    await expect(page.getByText('! ls', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(REPLY).first()).toBeVisible();
    await expect(block(page)).toHaveCount(0);
  } finally {
    if (sessionId) await remoteCall('chat.end', { sessionId }).catch(() => undefined);
    await markAllSeen(remoteCall);
    await forgetMachines();
  }
});

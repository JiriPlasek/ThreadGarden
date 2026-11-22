import { expect, test, type Locator, type Page } from '@playwright/test';
import { chatRow, markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

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

test('New chat sends ! as text', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New chat', exact: true });
  await dialog.getByRole('textbox', { name: 'First message' }).fill('! ls');
  await dialog.getByRole('textbox', { name: 'First message' }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('! ls', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(REPLY).first()).toBeVisible();
  await expect(block(page)).toHaveCount(0);
});

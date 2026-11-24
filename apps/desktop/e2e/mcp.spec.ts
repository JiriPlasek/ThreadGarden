import { expect, test, type Locator, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { chatRow, markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * MCP servers in the chat (protocol 12) end to end, against the mock: every
 * Claude chat has fake servers in every state, and the chats in `proj-0` (and
 * the remote mock's `tg-cli`) have `mock-etoro` in `.mcp.json`, waiting for
 * approval. `mock.mcpReset` puts the servers and the approvals back. The
 * phone layout's check is in phone.spec.ts (it needs the phone's UI build).
 */
const MACHINE = 'Ubuntu';
/** A This PC chat in `proj-0` (every 50th session is; no other spec opens these two). */
const LIVE_CHAT = 'session-950';
const PAUSED_CHAT = 'session-900';
/** The remote mock's newest chat, in its `tg-cli` (as machines.spec.ts). */
const REMOTE_CHAT = 'session-19';
const REPLY = 'This is the Threadgarden mock service answering.';
const BANNER = 'MCP server "mock-etoro" (from this project) isn\'t approved.';

const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

test.beforeEach(async () => {
  await forgetMachines();
  await serviceCall('mock.mcpReset', {});
  await remoteCall('mock.mcpReset', {});
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
  await markAllSeen(remoteCall);
});

const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const dialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'MCP servers (this chat)' });
const row = (page: Page, name: string): Locator =>
  dialog(page).getByTestId('mcp-row').filter({ hasText: name });

/** Opens a This PC chat from the list and makes it live with one message. */
const openLiveChat = async (page: Page, sessionId: string): Promise<void> => {
  await openApp(page);
  await (await chatRow(page, sessionId)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', sessionId);
  await composer(page).fill('Hello from the MCP test');
  await composer(page).press('Enter');
  await expect(page.getByText(REPLY).first()).toBeVisible();
};

/** The open chat's menu → MCP servers…. */
const openDialog = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Chat state' }).click();
  await page.getByRole('menuitem', { name: 'MCP servers…' }).click();
  await expect(dialog(page)).toBeVisible();
};

/** Settings → Machines → Add machine… with the remote mock's code. */
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
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

test('banner, Approve, then mock-etoro connects', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  const banner = page.getByRole('status', { name: 'MCP server not approved' });
  await expect(banner).toContainText(BANNER);
  await banner.getByRole('button', { name: 'Approve' }).click();
  await expect(banner).toBeHidden();

  await openDialog(page);
  await expect(row(page, 'mock-etoro')).toContainText('Connected');
});

test('/mcp opens the dialog with every status', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await composer(page).fill('/mcp');
  await composer(page).press('Enter');
  await expect(dialog(page)).toBeVisible();
  const expected: [string, string][] = [
    ['github', 'Connected'],
    ['mock-notion', 'Needs sign-in'],
    ['mock-oauth', 'Needs sign-in'],
    ['context7', 'Failed: timeout'],
    ['mock-slow', 'Connecting…'],
    ['mock-off', 'Off'],
    ['mock-etoro', 'Not approved'],
  ];
  for (const [name, status] of expected) await expect(row(page, name)).toContainText(status);
  await expect(row(page, 'mock-etoro').getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('Reconnect a failed server', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const failed = row(page, 'context7');
  await expect(failed).toContainText('Failed: timeout');
  await failed.getByRole('button', { name: 'Reconnect' }).click();
  await expect(failed).toContainText('Connected');
});

test('Turn off and on', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const github = row(page, 'github');
  await github.getByRole('button', { name: 'More for github' }).click();
  await page.getByRole('menuitem', { name: 'Turn off in this project' }).click();
  await expect(github).toContainText('Off');
  await github.getByRole('button', { name: 'Turn on' }).click();
  await expect(github).toContainText('Connected');
});

test('sign in on the remote mock needs the pasted address', async ({ page }) => {
  await openApp(page);
  await pairUbuntu(page);
  await (await chatRow(page, REMOTE_CHAT)).click();
  await expect(page.getByTitle(`Runs on ${MACHINE}`)).toBeVisible();
  await composer(page).fill('Hello from the MCP test');
  await composer(page).press('Enter');
  await expect(page.getByText(REPLY).first()).toBeVisible();
  await openDialog(page);

  const oauth = row(page, 'mock-oauth');
  await oauth.getByRole('button', { name: 'Sign in' }).click();
  const field = oauth.getByLabel("Paste the address from your browser's address bar");
  await expect(field).toBeVisible();
  // A wrong address is refused, and the field stays for another try.
  await field.fill('http://localhost/callback?state=x');
  await oauth.getByRole('button', { name: 'Finish sign-in' }).click();
  await expect(oauth.getByRole('alert')).toHaveText('Missing authorization code');
  await field.fill('http://localhost/callback?code=abc&state=x');
  await oauth.getByRole('button', { name: 'Finish sign-in' }).click();
  // No manual Reconnect: the dialog reconnects after the pasted address.
  await expect(oauth).toContainText('Connected');
  await expect(field).toHaveCount(0);
});

test('sign in on This PC: "I\'ve signed in" reconnects', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const oauth = row(page, 'mock-oauth');
  await oauth.getByRole('button', { name: 'Sign in' }).click();
  await expect(oauth.getByText('Finish signing in in your browser, then:')).toBeVisible();
  // The mock's simulated browser saves the token on its own; the server still needs the
  // reconnect. Clicking before that falls back to Needs sign-in, so click until it connects.
  await expect(async () => {
    await oauth.getByRole('button', { name: "I've signed in" }).click({ timeout: 2000 });
    await expect(oauth).toContainText('Connected', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await expect(oauth.getByText('Finish signing in in your browser, then:')).toHaveCount(0);
});

test('a paused chat offers Wake the chat', async ({ page }) => {
  await openApp(page);
  await (await chatRow(page, PAUSED_CHAT)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', PAUSED_CHAT);
  await openDialog(page);
  await expect(dialog(page)).toContainText("This chat isn't running");
  await dialog(page).getByRole('button', { name: 'Wake the chat' }).click();
  await expect(row(page, 'github')).toContainText('Connected');
  await expect(row(page, 'mock-etoro')).toContainText('Not approved');
});

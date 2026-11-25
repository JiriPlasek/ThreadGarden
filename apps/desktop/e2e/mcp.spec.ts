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
  await remoteCall('chat.end', { sessionId: REMOTE_CHAT });
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

/**
 * Wakes the remote chat with one message. Its transcript changed seconds ago
 * (the test before ended it), so Threadgarden may ask first: Continue here.
 */
const sayHelloOnRemote = async (page: Page): Promise<void> => {
  await composer(page).fill('Hello from the MCP test');
  await composer(page).press('Enter');
  const ask = page.getByRole('alertdialog', { name: 'Continue this chat here?' });
  // It asks within a moment, or not at all (the reply may already be in the transcript).
  if (
    await ask.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await ask.getByRole('button', { name: 'Continue here' }).click();
  }
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
  await sayHelloOnRemote(page);
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

test('Forget sign-in drops a signed-in server back to Needs sign-in', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const oauth = row(page, 'mock-oauth');
  await oauth.getByRole('button', { name: 'Sign in' }).click();
  await expect(async () => {
    await oauth.getByRole('button', { name: "I've signed in" }).click({ timeout: 2000 });
    await expect(oauth).toContainText('Connected', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });

  await oauth.getByRole('button', { name: 'More for mock-oauth' }).click();
  await page.getByRole('menuitem', { name: /^Forget sign-in on/ }).click();
  await expect(oauth).toContainText('Needs sign-in');
  await expect(oauth.getByRole('button', { name: 'Sign in' })).toBeVisible();
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

/** The dialog's + Add server form, filled for an http server (one header). */
const fillHttp = async (page: Page, name: string, url: string): Promise<Locator> => {
  await dialog(page).getByRole('button', { name: '+ Add server' }).click();
  await dialog(page).getByLabel('Name').fill(name);
  await dialog(page).getByLabel('URL', { exact: true }).fill(url);
  return dialog(page);
};

test('add an http server; it appears and offers Sign in', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const form = await fillHttp(page, 'mock-added', 'https://mcp.example.test/mcp');
  await form.getByRole('button', { name: '+ add' }).click();
  await form.getByLabel('Header name 1').fill('Authorization');
  await form.getByLabel('Header value 1').fill('Bearer E2E-SECRET');
  // Masked while typed.
  await expect(form.getByLabel('Header value 1')).toHaveAttribute('type', 'password');
  await form.getByRole('button', { name: 'Add', exact: true }).click();

  const added = row(page, 'mock-added');
  await expect(added).toContainText('local');
  await expect(added).toContainText('Needs sign-in');
  await expect(added.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.content()).not.toContain('E2E-SECRET');
});

test('add a stdio server with arguments and environment', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const form = dialog(page);
  await form.getByRole('button', { name: '+ Add server' }).click();
  await form.getByLabel('Name').fill('mock-stdio');
  await form.getByText('Command (stdio)').click();
  await form.getByLabel('Command', { exact: true }).fill('npx');
  await form.getByLabel('Arguments (one per line)').fill('-y\nsome-mcp-server');
  await form.getByRole('button', { name: '+ add' }).click();
  await form.getByLabel('Environment name 1').fill('API_KEY');
  await form.getByLabel('Environment value 1').fill('E2E-ENV-SECRET');
  await form.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(row(page, 'mock-stdio')).toContainText('Connected');
  expect(await page.content()).not.toContain('E2E-ENV-SECRET');
});

test("a taken name shows Claude Code's words", async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const form = await fillHttp(page, 'github', 'https://mcp.example.test/mcp');
  await form.getByLabel('Me, every project').check();
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText(
    'MCP server github already exists in user config',
  );
});

test('remove asks first, then the row goes', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  const off = row(page, 'mock-off');
  await off.getByRole('button', { name: 'More for mock-off' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove mock-off?' });
  await expect(confirm).toContainText('stops using it');
  // Cancelling keeps it.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(off).toBeVisible();

  await off.getByRole('button', { name: 'More for mock-off' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(row(page, 'mock-off')).toHaveCount(0);
});

test('no Remove for claude.ai and plugin servers', async ({ page }) => {
  await openLiveChat(page, LIVE_CHAT);
  await openDialog(page);
  for (const name of ['mock-notion', 'context7']) {
    const r = row(page, name);
    await expect(r).toBeVisible();
    const more = r.getByRole('button', { name: `More for ${name}` });
    if ((await more.count()) > 0) {
      await more.click();
      await expect(page.getByRole('menuitem', { name: 'Remove' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  }
});

test('add on the remote mock', async ({ page }) => {
  await openApp(page);
  await pairUbuntu(page);
  await (await chatRow(page, REMOTE_CHAT)).click();
  await sayHelloOnRemote(page);
  await openDialog(page);
  const form = await fillHttp(page, 'remote-added', 'https://mcp.example.test/mcp');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row(page, 'remote-added')).toContainText('Needs sign-in');
});

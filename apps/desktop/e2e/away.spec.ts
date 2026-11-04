import { expect, test, type Page } from '@playwright/test';
import {
  FAKE_PLUG,
  FAKE_SWITCH_PASSWORD,
  FAKE_SWITCH_PORT,
  REMOTE_MOCK_PORT,
  REMOTE_PAIRING_CODE,
} from './env';
import { chatRow, markAllSeen, openApp, remoteCall, resetTabs, serviceCall } from './helpers';

/**
 * A machine that's away (away machine spec) end to end: This PC pairs with the
 * headless mock "Ubuntu", keeps a copy of its chats while it is connected, and
 * then Ubuntu is switched off (`mock.goAway`: its links drop, nothing answers,
 * its plug `MockPlug` reads Off). Its chats still read from the copy, and a
 * message written for it waits in This PC's service, which turns it on
 * through the plug (the remote mock is back about 2 s after its plug is
 * switched on) and delivers the message once.
 *
 * The messages stay clear of the mock's script words ("perm", "ask", "plan",
 * "agent", "server", "limit"), so each gets the plain reply. They stay on the
 * remote mock for the specs after this one: replies in session-16 to
 * session-18, and one new chat in tg-cli.
 *
 * A waiting message lives only from its Send until the next delivery round
 * (about 5 s), so what it showed is recorded in the page as it happens
 * (`recordWaiting`) and checked afterwards, and the turn-on is checked on the
 * plug itself: off before the message, on after it went out.
 */
const MACHINE = 'Ubuntu';
const PROJECT = 'tg-cli';
const REPLY = 'This is the Threadgarden mock service answering.';
/** The line under a message that waits while nothing can turn Ubuntu on. */
const WAITING_REACHABLE = `⏳ Waiting for ${MACHINE} — sends when it's reachable.`;
/** The line under a message that waits while This PC turns Ubuntu on. */
const WAITING_OFF = `⏳ Waiting for ${MACHINE} — turning it on, sends when it's up. Keep this device awake.`;
/** Any line under a message that waits for Ubuntu. */
const WAITING = new RegExp(`^⏳ Waiting for ${MACHINE} — `);
/** The note over a chat of Ubuntu's while its plug reads Off (from its copy, or as it was). */
const OFF_NOTE = new RegExp(`^${MACHINE} is off: showing`);
/** The same note while it's away without showing as Off (no power control). */
const AWAY_NOTE = new RegExp(`^${MACHINE} isn't connected: showing`);
/** A message that waits for its machine, or goes out. */
const AWAY_ITEM = '[data-away-item]';
/** Turning Ubuntu on and delivering takes a start (about 2 s), the next look (5 s) and a reconnect. */
const DELIVERY_MS = 45_000;

/** A chat item as far as these checks go: the user's words are `text`, Claude's `markdown`. */
type Item = { kind: string; text?: string; markdown?: string };

/** Ubuntu's group in the places column. */
const ubuntuGroup = (page: Page) =>
  page.getByRole('navigation', { name: 'Places' }).getByRole('group', { name: MACHINE });

/** Forgets every paired machine (and so its copy, power control and waiting messages). */
const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

test.beforeEach(async () => {
  await remoteCall('mock.comeBack', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
  await markAllSeen(remoteCall);
});

test.afterEach(async () => {
  // Ubuntu is on again for the specs after this one, which see This PC alone.
  await remoteCall('mock.comeBack', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
  await markAllSeen(remoteCall);
});

/** Settings → Machines → Add machine… with the remote mock's code; returns its machine id. */
const pairUbuntu = async (page: Page, o: { power?: boolean } = {}): Promise<string> => {
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
  const entry = settings.getByRole('group', { name: MACHINE });
  await expect(entry.getByText('On', { exact: true })).toBeVisible();
  if (o.power) {
    // Power control with the fake switch's plug, as power.spec.ts sets it up.
    const power = entry.getByRole('group', { name: 'Power control' });
    await power.getByRole('button', { name: 'Set up power control…' }).click();
    const setup = page.getByRole('dialog', { name: 'Set up power control' });
    await setup.getByLabel('Address').fill(`127.0.0.1:${FAKE_SWITCH_PORT}`);
    await setup.getByLabel('Password').fill(FAKE_SWITCH_PASSWORD);
    await setup.getByRole('button', { name: 'Connect' }).click();
    await setup.getByRole('radio', { name: new RegExp(`^${FAKE_PLUG} — `) }).check();
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByRole('button', { name: 'Save' }).click();
    await expect(setup).toBeHidden();
    await expect(power.getByText(FAKE_PLUG, { exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  const paired = await serviceCall<{ id: string; name: string }[]>('machines.list', {});
  return paired.find((m) => m.name === MACHINE)!.id;
};

/**
 * Waits until This PC's copy of Ubuntu's chat `sessionId` has a message
 * starting with `text` (the desktop saves it while Ubuntu is connected, a
 * moment after a change). The
 * UI shows no sign of a copy while the machine is on: the local service is asked.
 */
const copied = async (machineId: string, sessionId: string, text: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const copy = await serviceCall<{ items: Item[] } | null>('copies.chat', {
          machineId,
          sessionId,
        });
        return copy?.items.some((i) => (i.text ?? i.markdown)?.startsWith(text)) ?? false;
      },
      { message: `the copy of ${sessionId} has "${text}"`, timeout: 30_000 },
    )
    .toBe(true);
};

/** Waits until This PC's copy of Ubuntu has chat `sessionId`, whatever its last messages. */
const copiedChat = async (machineId: string, sessionId: string): Promise<void> => {
  await expect
    .poll(
      async () =>
        (await serviceCall<{ sessionId: string } | null>('copies.chat', { machineId, sessionId }))
          ?.sessionId ?? null,
      { message: `the copy of ${sessionId}`, timeout: 30_000 },
    )
    .toBe(sessionId);
};

/** Switches Ubuntu off and waits until This PC shows it as away (its group says when it was last seen). */
const goAway = async (page: Page): Promise<void> => {
  await remoteCall('mock.goAway', {});
  await expect(ubuntuGroup(page).getByText(/^last seen /)).toBeVisible();
};

/** Ubuntu's `tg-cli` in the places column (its chats in the list, from the copy while away). */
const showProject = async (page: Page): Promise<void> => {
  await ubuntuGroup(page).getByRole('button', { name: PROJECT }).click();
};

/** How many of Ubuntu's own messages in chat `sessionId` say `text` (Ubuntu must be on). */
const onUbuntu = async (sessionId: string, text: string): Promise<number> => {
  const opened = await remoteCall<{ items: Item[] }>('chat.open', { sessionId, tail: 50 });
  return opened.items.filter((i) => i.kind === 'user' && i.text === text).length;
};

/** Whether This PC's service reads Ubuntu's plug as on (it may answer from a reading 3 s old). */
const plugOn = async (machineId: string): Promise<boolean | null> =>
  (await serviceCall<{ on: boolean | null }>('power.reading', { machineId })).on;

/**
 * Records in the page, from now on, which of `texts` the page has shown, so a
 * line that came and went between two of the test's looks still counts.
 * Returns a function that reads what was recorded so far.
 */
const recordShown = async (page: Page, texts: string[]): Promise<() => Promise<string[]>> => {
  await page.evaluate((texts) => {
    const seen = new Set<string>();
    (window as unknown as { __shown: Set<string> }).__shown = seen;
    const look = (): void => {
      const now = document.body.textContent ?? '';
      for (const t of texts) if (now.includes(t)) seen.add(t);
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    look();
  }, texts);
  return () =>
    page.evaluate(() => [...(window as unknown as { __shown: Set<string> }).__shown].sort());
};

test('an away machine shows its copied chats and the last messages', async ({ page }) => {
  const chat = 'session-18';
  const said = 'Did the moon cactus bloom while I was away?';
  await openApp(page);
  const ubuntuId = await pairUbuntu(page);
  // Written on Ubuntu itself while This PC is connected: the copy follows.
  await remoteCall('chat.send', { sessionId: chat, text: said });
  await copied(ubuntuId, chat, said);
  await copied(ubuntuId, chat, REPLY);

  await goAway(page);
  await showProject(page);
  await (await chatRow(page, chat)).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-tab', chat);
  const messages = page.getByRole('region', { name: 'Messages' });
  await expect(
    page.getByText(new RegExp(`^${MACHINE} isn't connected: showing its last few messages, from `)),
  ).toBeVisible();
  await expect(page.getByText(`… earlier messages are on ${MACHINE}`)).toBeVisible();
  await expect(messages.getByText(said)).toBeVisible();
  await expect(messages.getByText(REPLY)).toBeVisible();
});

test('a reply while away turns it on and is delivered once', async ({ page }) => {
  test.setTimeout(120_000);
  const chat = 'session-17';
  const reply = 'Water the moon cactus twice, it looks thirsty';
  await openApp(page);
  const ubuntuId = await pairUbuntu(page, { power: true });
  await copiedChat(ubuntuId, chat);
  await goAway(page);
  await showProject(page);
  await (await chatRow(page, chat)).click();
  await expect(page.getByText(OFF_NOTE)).toBeVisible();
  // Off, and nothing turns it on until a message waits.
  await expect.poll(() => plugOn(ubuntuId)).toBe(false);

  const shown = await recordShown(page, [WAITING_OFF]);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(reply);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');

  // This PC switches the plug on at once (only the plug brings Ubuntu back here: nothing
  // calls `mock.comeBack`), and the reply goes out once it's up, about 5 s later.
  await expect.poll(() => plugOn(ubuntuId), { timeout: DELIVERY_MS }).toBe(true);
  const waiting = page.locator(AWAY_ITEM).filter({ hasText: reply });
  await expect(waiting).toHaveCount(0, { timeout: DELIVERY_MS });
  // Meanwhile it waited, saying Ubuntu was being turned on.
  expect(await shown()).toEqual([WAITING_OFF]);

  // The chat is live again, with the reply and its answer.
  await expect(page.getByText(OFF_NOTE)).toHaveCount(0, { timeout: DELIVERY_MS });
  await expect(ubuntuGroup(page).getByText('On', { exact: true })).toBeVisible();
  const messages = page.getByRole('region', { name: 'Messages' });
  await expect(messages.getByText(REPLY)).toBeVisible({ timeout: DELIVERY_MS });
  await expect(messages.getByText(reply)).toHaveCount(1);
  // Ubuntu got it exactly once.
  expect(await onUbuntu(chat, reply)).toBe(1);
  expect((await serviceCall<{ items: unknown[] }>('away.list', {})).items).toEqual([]);
});

test('Cancel removes a waiting reply', async ({ page }) => {
  const chat = 'session-16';
  const reply = 'Never mind, the cactus can wait';
  await openApp(page);
  // No power control: nothing turns Ubuntu on, so the reply waits until it's cancelled.
  const ubuntuId = await pairUbuntu(page);
  await copiedChat(ubuntuId, chat);
  await goAway(page);
  await showProject(page);
  await (await chatRow(page, chat)).click();
  await expect(page.getByText(AWAY_NOTE)).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(reply);
  await composer.press('Enter');
  const waiting = page.locator(AWAY_ITEM).filter({ hasText: reply });
  await expect(waiting.getByText(WAITING_REACHABLE)).toBeVisible();
  await waiting.getByRole('button', { name: 'Cancel' }).click();
  await expect(waiting).toHaveCount(0);
  await expect(page.getByText(WAITING)).toHaveCount(0);
  expect((await serviceCall<{ items: unknown[] }>('away.list', {})).items).toEqual([]);

  // Back on, the chat is live again, and the cancelled reply never went out.
  await remoteCall('mock.comeBack', {});
  await expect(page.getByText(AWAY_NOTE)).toHaveCount(0, { timeout: 30_000 });
  await expect(ubuntuGroup(page).getByText('On', { exact: true })).toBeVisible();
  expect(await onUbuntu(chat, reply)).toBe(0);
  await expect(page.getByRole('region', { name: 'Messages' }).getByText(reply)).toHaveCount(0);
});

test("a new chat while away opens at once and starts when it's up", async ({ page }) => {
  test.setTimeout(120_000);
  const first = 'Sow a tiny forest of bonsai tests';
  await openApp(page);
  const ubuntuId = await pairUbuntu(page, { power: true });
  await copiedChat(ubuntuId, 'session-19');
  await goAway(page);
  await showProject(page);
  await expect.poll(() => plugOn(ubuntuId)).toBe(false);

  // New chat in Ubuntu's tg-cli, from the copy's folders.
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  const machine = dialog.getByRole('combobox', { name: 'Machine' });
  await expect(machine).toHaveValue(ubuntuId);
  await expect(machine.locator('option:checked')).toHaveText(new RegExp(`^${MACHINE} \\(.+\\)$`));
  const folder = dialog.getByRole('combobox', { name: /folder/i });
  await folder.selectOption({ label: PROJECT });
  const message = dialog.getByRole('textbox', { name: /message/i });
  await message.fill(first);
  const starting = `Starting ${MACHINE}…`;
  const shown = await recordShown(page, [WAITING_OFF, starting]);
  await message.press('Enter');
  await expect(dialog).toBeHidden();

  // At once: its tab, keyed by the id This PC chose (the tab stays, whatever happens next).
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveAttribute('data-chat-key', new RegExp(`^${ubuntuId}/[0-9a-f-]{36}$`));
  const key = (await tab.getAttribute('data-chat-key'))!;
  const sessionId = key.slice(ubuntuId.length + 1);

  // Ubuntu is turned on, makes the chat under that id, and the same tab is its live chat.
  await expect.poll(() => plugOn(ubuntuId), { timeout: DELIVERY_MS }).toBe(true);
  await expect(page.getByText(starting)).toHaveCount(0, { timeout: DELIVERY_MS });
  await expect(page.locator(AWAY_ITEM).filter({ hasText: first })).toHaveCount(0, {
    timeout: DELIVERY_MS,
  });
  // Meanwhile the tab said it was starting, with its first message waiting for the turn-on.
  expect(await shown()).toEqual([starting, WAITING_OFF].sort());
  const messages = page.getByRole('region', { name: 'Messages' });
  await expect(messages.getByText(first)).toBeVisible({ timeout: DELIVERY_MS });
  await expect(messages.getByText(REPLY)).toBeVisible({ timeout: DELIVERY_MS });
  await expect(tab).toHaveAttribute('data-chat-key', key);
  await expect(page.getByRole('tablist', { name: 'Open chats' }).getByRole('tab')).toHaveCount(1);
  expect(await onUbuntu(sessionId, first)).toBe(1);
});

import { expect, test, type Page } from '@playwright/test';
import { REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE } from './env';
import { MOCK_CHATS, chatRow, markAllSeen, openApp, resetTabs, serviceCall } from './helpers';

/**
 * Move a chat to another machine (protocol 9) end to end: This PC (the mock
 * service) pairs with the headless mock "Ubuntu", moves one of its chats
 * there with Move to…, and back again. The mocks fake a clean git state for
 * their projects, so the checks pass and Claude's first note names the repo.
 */
const MACHINE = 'Ubuntu';
/** A This PC chat no other spec opens (the remote mock's own ids stop at session-19). */
const CHAT = 'session-995';
const NOTE = '[Threadgarden] This chat moved from';
const REPLY = 'This is the Threadgarden mock service answering.';

/** Forgets every paired machine, so the specs after this one see This PC only. */
const forgetMachines = async (): Promise<void> => {
  const paired = await serviceCall<{ id: string }[]>('machines.list', {});
  for (const m of paired) await serviceCall('machines.remove', { machineId: m.id, revoke: true });
};

/** This PC's count of active chats (the moved-away copy is not listed). */
const activeHere = async (): Promise<number> =>
  (await serviceCall<{ all: number }>('places.counts', {})).all;

test.beforeEach(async () => {
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

test.afterEach(async () => {
  // The mock's test reset: a move that failed half-way leaves no chat moved away from This PC
  // (the specs after this one count This PC's chats).
  await serviceCall('mock.forgetMoves', {});
  await forgetMachines();
  await resetTabs();
  await markAllSeen();
});

/** Settings → Machines → Add machine… with the remote mock's code; returns its machine id. */
const pairUbuntu = async (page: Page): Promise<string> => {
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
  const paired = await serviceCall<{ id: string; name: string }[]>('machines.list', {});
  return paired.find((m) => m.name === MACHINE)!.id;
};

/** The open chat's Chat state menu → Move to… → `machine` → Move, until it says it moved. */
const moveTo = async (page: Page, machine: string): Promise<void> => {
  await page.getByRole('button', { name: 'Chat state' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move this chat' });
  await expect(dialog.getByLabel('Machine')).toHaveValue(/.+/);
  await expect(dialog.getByLabel('Machine').locator('option:checked')).toHaveText(machine);
  // The checks: not busy, a clean project, the target on; then Move (not Move anyway).
  await expect(dialog.getByText("The chat isn't busy.")).toBeVisible();
  await expect(dialog.getByText(/^The project is clean: nothing stays behind/)).toBeVisible();
  await expect(dialog.getByText(`${machine} is on.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(`Moved to ${machine}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
};

test('move a This PC chat to Ubuntu and back: one chat, its history, the first notes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  const ubuntuId = await pairUbuntu(page);
  const list = page.getByRole('region', { name: 'Chat list' });
  const messages = page.getByRole('region', { name: 'Messages' });
  const tab = page.getByRole('tab', { selected: true });

  // A message from the chat's history, to find again on each machine.
  const opened = await serviceCall<{ items: { kind: string; text?: string }[] }>('chat.open', {
    sessionId: CHAT,
    tail: 50,
  });
  const said = opened.items
    .filter((i) => i.kind === 'user')
    .at(-1)!
    .text!.slice(0, 40);

  await (await chatRow(page, CHAT)).click();
  await expect(tab).toHaveAttribute('data-tab', CHAT);
  await expect(page.getByTitle('Runs on This PC')).toBeVisible();
  await expect(messages.getByText(said)).toBeVisible();

  // To Ubuntu: the tab follows, the history is there, then Claude's first note (from Threadgarden) and its answer.
  await moveTo(page, MACHINE);
  await expect(tab).toHaveAttribute('data-chat-key', `${ubuntuId}/${CHAT}`);
  await expect(page.getByTitle(`Runs on ${MACHINE}`)).toBeVisible();
  await expect(messages.getByText(said)).toBeVisible();
  await expect(messages.getByText(NOTE)).toHaveCount(1);
  await expect(messages.getByText('Sent by Threadgarden')).toHaveCount(1);
  await expect(messages.getByText(REPLY)).toBeVisible();
  // This PC no longer lists it: the list has one row of it, on Ubuntu.
  expect(await activeHere()).toBe(MOCK_CHATS - 1);
  const row = list.locator(`[role="option"][data-session-id="${CHAT}"]`);
  await chatRow(page, CHAT);
  await expect(row).toHaveCount(1);
  await expect(row.getByText(MACHINE, { exact: true })).toBeVisible();

  // And back, once the note's turn has ended (a chat mid-turn can't move): one chat on This PC
  // again, with the turn it had on Ubuntu and a second note.
  await expect(tab.locator('[data-status]')).toHaveAttribute('data-status', /^(idle|yourTurn)$/);
  await moveTo(page, 'This PC');
  await expect(tab).toHaveAttribute('data-chat-key', new RegExp(`/${CHAT}$`));
  await expect(tab).not.toHaveAttribute('data-chat-key', `${ubuntuId}/${CHAT}`);
  await expect(page.getByTitle('Runs on This PC')).toBeVisible();
  await expect(messages.getByText('Sent by Threadgarden')).toHaveCount(2);
  await expect(messages.getByText(`${NOTE} ${MACHINE} to This PC.`)).toBeVisible();
  await expect(messages.getByText(REPLY)).toHaveCount(2);
  await expect.poll(activeHere).toBe(MOCK_CHATS);
  await chatRow(page, CHAT);
  await expect(row).toHaveCount(1);
  await expect(row.getByText(MACHINE, { exact: true })).toHaveCount(0);
});

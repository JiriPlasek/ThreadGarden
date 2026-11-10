import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_PLUG, FAKE_SWITCH_PASSWORD, FAKE_SWITCH_PORT } from './env';
import { markAllSeen, phoneCall, remoteCall } from './helpers';

/**
 * The phone layout (phone plan, Task 12) at a phone's viewport with touch,
 * against the phone mock: no chats of its own, the remote mock "Ubuntu"
 * (20 chats in tg-cli) paired. Back is the browser's (the Android back
 * gesture goes back in the webview the same way).
 */

const MACHINE = 'Ubuntu';

test.beforeEach(async () => {
  // The phone's tabs (Recent chats) are kept by its core, here the phone mock.
  await phoneCall('uiState.set', { key: 'tabs', value: { open: [], active: null } });
  await markAllSeen(remoteCall);
});

const places = (page: Page): Locator => page.getByRole('navigation', { name: 'Places' });
const chatList = (page: Page): Locator => page.getByRole('region', { name: 'Chat list' });
const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const row = (page: Page, sessionId: string): Locator =>
  chatList(page).locator(`[role="option"][data-session-id="${sessionId}"]`);

/** Opens the app on the places, once the phone mock has paired with Ubuntu. */
const openPhone = async (page: Page): Promise<void> => {
  await page.goto('/');
  await expect(places(page).getByRole('group', { name: MACHINE })).toBeVisible({
    timeout: 60_000,
  });
};

/** From the places: the tg-cli project's chats. */
const openProject = async (page: Page): Promise<void> => {
  await places(page)
    .getByRole('group', { name: MACHINE })
    .getByRole('button', { name: /tg-cli/ })
    .tap();
  await expect(chatList(page)).toBeVisible();
};

/** From the places: chat `sessionId` of tg-cli. */
const openChat = async (page: Page, sessionId: string): Promise<void> => {
  await openProject(page);
  await row(page, sessionId).tap();
  await expect(composer(page)).toBeVisible();
};

const titleOf = async (sessionId: string): Promise<string> => {
  const { items } = await remoteCall<{ items: { title: string }[] }>('sessions.summaries', {
    sessionIds: [sessionId],
  });
  return items[0]!.title;
};

const send = async (page: Page, text: string): Promise<void> => {
  await composer(page).fill(text);
  await composer(page).press('Enter');
};

test('a chat opens from a machine, and back returns to its list', async ({ page }) => {
  await openPhone(page);
  // One column at a time: the places only.
  await expect(chatList(page)).toHaveCount(0);
  await openChat(page, 'session-3');
  await expect(chatList(page)).toHaveCount(0);
  await expect(places(page)).toHaveCount(0);

  // The back gesture goes up one level at a time.
  await page.goBack();
  await expect(chatList(page)).toBeVisible();
  await expect(row(page, 'session-3')).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await page.goBack();
  await expect(places(page)).toBeVisible();

  // So does the on-screen Back.
  await openChat(page, 'session-3');
  await page.getByRole('button', { name: 'Back to chats' }).tap();
  await expect(chatList(page)).toBeVisible();
  await page.getByRole('button', { name: 'Back to places' }).tap();
  await expect(places(page)).toBeVisible();
});

test('a reply goes to that machine', async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-4');
  const sent = Date.now() - 1_000;
  await send(page, 'Hello from the phone test');
  await expect(page.getByText('Hello from the phone test')).toBeVisible();
  await expect(page.getByText('This is the Threadgarden mock service answering.')).toBeVisible();
  // Ubuntu ran the turn: its own list has the chat active since it was sent.
  await expect
    .poll(async () => {
      const { items } = await remoteCall<{ items: { lastActivity: number }[] }>(
        'sessions.summaries',
        { sessionIds: ['session-4'] },
      );
      return items[0]?.lastActivity ?? 0;
    })
    .toBeGreaterThanOrEqual(sent);
});

test('a question from Claude can be answered by touch', async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-5');
  await send(page, 'Please ask me which way');
  const form = page.getByRole('form', { name: 'Question from Claude' });
  await expect(form).toBeVisible();
  await form.getByText('Rewrite', { exact: true }).tap();
  await form.getByRole('button', { name: 'Answer' }).tap();
  await expect(page.getByText(/Thanks\. Your answer:.*Rewrite/)).toBeVisible();
});

test('Needs you and Running list across machines', async ({ page }) => {
  await openPhone(page);
  // A permission request on Ubuntu waits for the owner.
  await openChat(page, 'session-6');
  await send(page, 'List the files, perm needed');
  await expect(page.getByRole('group', { name: 'Permission request: Bash' })).toBeVisible();
  // A background server on Ubuntu keeps running.
  await page.getByRole('button', { name: 'Back to chats' }).tap();
  await row(page, 'session-7').tap();
  await send(page, 'Start the dev server');
  await expect(page.getByText('npm run dev').first()).toBeVisible();

  await page.goBack();
  await page.goBack();
  // Counted on the places (earlier specs may leave other requests waiting on Ubuntu).
  await expect(places(page).locator('[title="Waiting for you"]')).toHaveText(/^[1-9]\d*$/);
  await places(page)
    .getByRole('button', { name: /Needs you/ })
    .tap();
  await expect(row(page, 'session-6')).toBeVisible();
  await expect(row(page, 'session-7')).toHaveCount(0);
  await page.goBack();
  await places(page)
    .getByRole('button', { name: /Running/ })
    .tap();
  await expect(row(page, 'session-7')).toBeVisible();

  // Answer the request from the list, by touch.
  await page.goBack();
  await places(page)
    .getByRole('button', { name: /Needs you/ })
    .tap();
  await row(page, 'session-6').tap();
  await page
    .getByRole('group', { name: 'Permission request: Bash' })
    .getByRole('button', { name: 'Allow', exact: true })
    .tap();
  await expect(
    page.getByText('There are three entries: README.md, package.json and src.'),
  ).toBeVisible();
  // The server goes, so the chats after this one start quiet.
  await remoteCall('chat.end', { sessionId: 'session-7' });
});

test('search finds a chat on a machine', async ({ page }) => {
  await openPhone(page);
  const title = await titleOf('session-8');
  await places(page)
    .getByRole('button', { name: /^Active/ })
    .tap();
  await chatList(page).getByRole('searchbox', { name: 'Search chats' }).fill(title);
  await expect(row(page, 'session-8')).toBeVisible();
  await row(page, 'session-8').tap();
  await expect(composer(page)).toBeVisible();
});

test('a new chat starts on the chosen machine', async ({ page }) => {
  await openPhone(page);
  await openProject(page);
  await page.getByRole('button', { name: 'New chat' }).tap();
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  await expect(dialog.getByRole('combobox', { name: 'Machine' })).toHaveValue(/.+/);
  await expect(dialog.getByRole('combobox', { name: 'Machine' })).toContainText(MACHINE);
  await expect(dialog.getByRole('combobox', { name: 'Machine' })).not.toContainText('This PC');
  const before = await remoteCall<{ items: { sessionId: string }[] }>('sessions.list', {
    place: { kind: 'active' },
    limit: 200,
  });
  await dialog.getByRole('textbox', { name: 'Message' }).fill('Set up the phone test');
  await dialog.getByRole('textbox', { name: 'Message' }).press('Enter');
  // The new chat is shown, on Ubuntu.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Set up the phone test').first()).toBeVisible();
  await expect
    .poll(async () => {
      const after = await remoteCall<{ items: { sessionId: string }[] }>('sessions.list', {
        place: { kind: 'active' },
        limit: 200,
      });
      return after.items.length - before.items.length;
    })
    .toBe(1);
  // Back returns to the list it was started from.
  await page.goBack();
  await expect(chatList(page)).toBeVisible();
});

test('recent chats switch', async ({ page }) => {
  await openPhone(page);
  const nine = await titleOf('session-9');
  await openChat(page, 'session-9');
  await page.getByRole('button', { name: 'Back to chats' }).tap();
  await row(page, 'session-10').tap();
  await expect(composer(page)).toBeVisible();

  await page.getByRole('button', { name: 'Recent chats (2)' }).tap();
  const recent = page.getByRole('dialog', { name: 'Recent chats' });
  await recent.getByRole('button', { name: nine, exact: true }).tap();
  await expect(recent).toHaveCount(0);
  await expect(page.getByRole('heading', { name: nine })).toBeVisible();
  // Still one chat deep: Back returns to the list.
  await page.goBack();
  await expect(chatList(page)).toBeVisible();
});

test('a long title keeps Recent chats on screen, and Close works', async ({ page }) => {
  // A made-up title far wider than the phone.
  const long =
    'A very long made-up chat title about the phone layout that never ends anywhere soon';
  await remoteCall('meta.update', { sessionId: 'session-14', customTitle: long });
  try {
    await openPhone(page);
    await openChat(page, 'session-14');
    await page.getByRole('button', { name: 'Back to chats' }).tap();
    await row(page, 'session-15').tap();
    await expect(composer(page)).toBeVisible();
    await page.getByRole('button', { name: 'Recent chats (2)' }).tap();
    const recent = page.getByRole('dialog', { name: 'Recent chats' });
    const close = recent.getByRole('button', { name: `Close ${long}` });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.tap();
    await expect(recent.getByRole('button', { name: long, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recent chats (1)' })).toBeVisible();
  } finally {
    await remoteCall('meta.update', { sessionId: 'session-14', customTitle: null });
  }
});

test('Back closes New chat and stays at the list; the same for Recent chats', async ({ page }) => {
  await openPhone(page);
  await openProject(page);
  await page.getByRole('button', { name: 'New chat' }).tap();
  const newChat = page.getByRole('dialog', { name: 'New chat' });
  await expect(newChat).toBeVisible();
  await page.goBack();
  await expect(newChat).toHaveCount(0);
  await expect(chatList(page)).toBeVisible();
  // Closed by its own X, its entry goes: Back then leaves the list.
  await page.getByRole('button', { name: 'New chat' }).tap();
  await expect(newChat).toBeVisible();
  await newChat.getByRole('button', { name: 'Close' }).tap();
  await expect(newChat).toHaveCount(0);
  await page.goBack();
  await expect(places(page)).toBeVisible();

  await openChat(page, 'session-3');
  await page.getByRole('button', { name: 'Back to chats' }).tap();
  await row(page, 'session-4').tap();
  await page.getByRole('button', { name: 'Recent chats (2)' }).tap();
  const recent = page.getByRole('dialog', { name: 'Recent chats' });
  await expect(recent).toBeVisible();
  await page.goBack();
  await expect(recent).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  await page.goBack();
  await expect(chatList(page)).toBeVisible();
});

test("the chat header fits the phone's width, before and after a turn", async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-12');
  const title = await titleOf('session-12');
  // The title is in the phone's bar; the header is one row of controls.
  await expect(page.getByRole('banner').first()).toContainText(title);
  const overflow = () =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const header = document.querySelector('main header');
      if (!header) return ['no header'];
      return [...header.querySelectorAll<HTMLElement>('*')]
        .filter((el) => el.getBoundingClientRect().right > width + 0.5)
        .map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? ''}`);
    });
  expect(await overflow()).toEqual([]);
  // Each picker says what it is ("Model: …", "Mode: …").
  await expect(
    page.getByRole('combobox', { name: 'Permission mode' }).locator('option:checked'),
  ).toHaveText(/^Mode: /);
  // The pickers read as words, not a letter.
  for (const name of ['Model', 'Permission mode']) {
    const box = await page.getByRole('combobox', { name }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(80);
  }
  await send(page, 'Hello from the header test');
  await expect(page.getByText('This is the Threadgarden mock service answering.')).toBeVisible();
  // After a turn: usage, cost and the plan don't push it wider.
  await expect(page.getByRole('combobox', { name: 'Permission mode' })).toBeEnabled();
  expect(await overflow()).toEqual([]);
  // Activity, Copy resume command and End session are in the menu.
  await page.getByRole('button', { name: 'Chat state' }).tap();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /activity/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy resume command' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'End session' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('bypass permissions asks first on the phone, as on the desktop', async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-13');
  await send(page, 'Hello from the bypass test');
  await expect(page.getByText('This is the Threadgarden mock service answering.')).toBeVisible();
  const mode = page.getByRole('combobox', { name: 'Permission mode' });
  await expect(mode).toBeEnabled();
  await mode.selectOption('plan');
  await expect(mode).toHaveValue('plan');
  await mode.selectOption('bypassPermissions');
  const confirmation = page.getByRole('alertdialog', { name: 'Enable bypass permissions?' });
  await expect(confirmation).toBeVisible();
  await expect(mode).toHaveValue('plan');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).tap();
  await expect(mode).toHaveValue('plan');
  await mode.selectOption('bypassPermissions');
  await confirmation.getByRole('button', { name: 'Enable bypass permissions', exact: true }).tap();
  await expect(confirmation).toBeHidden();
  // The machine's answer: the picker shows what the chat runs with.
  await expect(mode).toHaveValue('bypassPermissions');
  await expect(mode.locator('option:checked')).toHaveText('Mode: Bypass permissions');
  await mode.selectOption('default');
  await expect(mode).toHaveValue('default');
});

test('Settings shows nothing that needs a keyboard, and no tooltip stays after a tap', async ({
  page,
}) => {
  await openPhone(page);
  await page.getByRole('button', { name: 'Settings' }).tap();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByText(/Enter sends/)).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /Keyboard shortcuts/ })).toHaveCount(0);
  await expect(settings.getByText(/Ctrl\+|⌘/)).toHaveCount(0);
  await expect(settings.getByLabel('Interface size')).toBeVisible();
  await page.goBack();
  await expect(settings).toHaveCount(0);
  await expect(places(page)).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test("the keyboard doesn't cover the composer", async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-11');
  // The page resizes for the keyboard (Chrome on Android), and follows the visual viewport.
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /interactive-widget=resizes-content/,
  );
  await composer(page).tap();
  // A keyboard taking half the screen: Playwright can't show one, the viewport shrinks instead.
  await page.setViewportSize({ width: 412, height: 450 });
  await expect(composer(page)).toBeInViewport();
  const box = await composer(page).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(450);
  await expect(composer(page)).toBeFocused();
});

test("the shell keeps clear of Android's system bars", async ({ page }) => {
  await openPhone(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /viewport-fit=cover/,
  );
  const shell = page.locator('[data-phone-shell]');
  // Nothing to keep clear of in a browser.
  await expect(shell).toHaveCSS('padding-top', '0px');
  // A webview under the bars says how tall they are (here as the variables a native side sets).
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty('--sat', '32px');
    root.setProperty('--sab', '24px');
  });
  await expect(shell).toHaveCSS('padding-top', '32px');
  await expect(shell).toHaveCSS('padding-bottom', '24px');
  // The places start below the status bar, and the composer sits above the gesture bar.
  const top = await places(page).boundingBox();
  expect(top!.y).toBeGreaterThanOrEqual(32);
  await openChat(page, 'session-13');
  const box = await composer(page).boundingBox();
  const height = page.viewportSize()!.height;
  expect(box!.y + box!.height).toBeLessThanOrEqual(height - 24);
});

/** Every visible control under the phone's rule that is smaller than 44 px either way. */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const selector = [
      'button',
      'select',
      '[role="button"]',
      '[role="tab"]',
      '[role="option"]',
      'textarea',
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"])',
    ].join(',');
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden';
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 43.5 || r.height < 43.5;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '';
        return `${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`;
      });
  });

test('targets are at least 44 px', async ({ page }) => {
  await openPhone(page);
  expect(await smallTargets(page)).toEqual([]);
  await openProject(page);
  expect(await smallTargets(page)).toEqual([]);
  await row(page, 'session-12').tap();
  await expect(composer(page)).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
});

test('an image can be attached through the picker', async ({ page }) => {
  await openPhone(page);
  await openChat(page, 'session-13');
  // The system's picker (a file input for images); dropping files is the desktop's.
  const input = page.locator('input[type="file"]');
  await expect(input).toHaveAttribute('accept', 'image/*');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach images' }).tap();
  // A 1×1 PNG, made up for the test.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Attached image 1' })).toBeVisible();
});

test("Turn on works from the machine's menu", async ({ page }) => {
  // The phone's core turns machines on since Task 8; the phone mock refuses
  // what the core refuses (its contract table), so before that this skips.
  const refused = await phoneCall('power.turnOn', { machineId: 'none' }).then(
    () => false,
    (e: unknown) => String(e).includes('METHOD_NOT_FOUND'),
  );
  test.skip(refused, "The phone's core can't turn machines on yet (Task 8 not merged)");
  const ubuntu = await remoteCall<{ id: string }>('machine.get', {});
  try {
    await openPhone(page);
    // Its plug details, entered on the phone.
    const group = places(page).getByRole('group', { name: MACHINE });
    await group.getByRole('button', { name: `Power for ${MACHINE}` }).tap();
    await page.getByRole('menuitem', { name: 'Plug details…' }).tap();
    const plug = page.getByRole('dialog', { name: `Plug for ${MACHINE}` });
    await plug.getByLabel('Bridge address').fill(`127.0.0.1:${FAKE_SWITCH_PORT}`);
    await plug.getByLabel('Plug name').fill(FAKE_PLUG);
    await plug.getByLabel('Password').fill(FAKE_SWITCH_PASSWORD);
    await plug.getByRole('button', { name: 'Save' }).tap();
    await expect(plug).toHaveCount(0);

    // Ubuntu goes off; Turn on brings it back through its plug.
    await remoteCall('mock.goAway', {});
    await expect(group.getByText('Off')).toBeVisible({ timeout: 30_000 });
    await group.getByRole('button', { name: `Power for ${MACHINE}` }).tap();
    await page.getByRole('menuitem', { name: 'Turn on' }).tap();
    await expect(group.getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await remoteCall('mock.comeBack', {}).catch(() => {});
    await phoneCall('power.configure', { machineId: ubuntu.id, config: null }).catch(() => {});
  }
});

test("the update notice opens the release's APK", async ({ page }) => {
  await openPhone(page);
  const notice = page.getByRole('status').filter({ hasText: /is available/ });
  await expect(notice).toContainText(/Threadgarden \d+\.\d+\.\d+ is available/);
  // The browser stands in for Android's: the APK's address opens there.
  const opened = page.waitForEvent('popup');
  await notice.getByRole('button', { name: 'Download' }).tap();
  expect((await opened).url()).toMatch(
    /^https:\/\/github\.com\/JiriPlasek\/ThreadGarden\/releases\/download\/v.+\/threadgarden-.+\.apk$/,
  );
});

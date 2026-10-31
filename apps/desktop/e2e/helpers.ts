import { expect, type Locator, type Page } from '@playwright/test';
import { MOCK_PORT, MOCK_TOKEN } from './env';

/** Chats in the mock's history: 1,000 generated sessions plus one big one. */
export const MOCK_CHATS = 1001;

/** Budget multiplier for slower machines (`THREADGARDEN_PERF_SLACK`, CI sets 3 — ruling R3). */
export const slack = Number(process.env.THREADGARDEN_PERF_SLACK ?? 1);

/** Opens the app and waits until the mock's whole history is indexed and listed. */
export const openApp = async (page: Page): Promise<void> => {
  await page.goto('/');
  const places = page.getByRole('navigation', { name: 'Places' });
  await expect(places.locator('[title="Active chats"]')).toHaveText(String(MOCK_CHATS), {
    timeout: 60_000,
  });
};

/** One request to the mock service over its WebSocket, from the test process. */
export const serviceCall = async <T>(method: string, params: unknown): Promise<T> => {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK_PORT}`, [`threadgarden.${MOCK_TOKEN}`]);
  try {
    return await new Promise<T>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
      ws.onerror = () => reject(new Error(`${method}: WebSocket error`));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { id?: number; result?: T; error?: unknown };
        if (m.id !== 1) return;
        if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
        else resolve(m.result as T);
      };
    });
  } finally {
    ws.close();
  }
};

/**
 * Nothing unread: a spec that ends right after a chat's turn finished leaves
 * it unread ("Your turn", counted under Needs you) in the shared mock, as the
 * window closed before the chat counted as seen. A spec can also end while a
 * turn it started still runs (it saw what it waited for mid-turn): that turn
 * ends first (at most 15 s), or it would turn unread afterwards.
 */
export const markAllSeen = async (): Promise<void> => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const running = await serviceCall<{ items: { status: string }[] }>('sessions.list', {
      place: { kind: 'running' },
      limit: 200,
    });
    if (!running.items.some((s) => s.status === 'working') || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const { items } = await serviceCall<{ items: { sessionId: string }[] }>('sessions.list', {
    place: { kind: 'needsYou' },
    limit: 200,
  });
  for (const s of items) await serviceCall('chat.markSeen', { sessionId: s.sessionId });
};

/** No open tabs: the mock service keeps the tab layout between tests (`uiState`). */
export const resetTabs = async (): Promise<void> => {
  await serviceCall('uiState.set', { key: 'tabs', value: { open: [], active: null } });
};

/**
 * What must be true in the DOM for an interaction to count as done:
 * `selector` matches, and, when `keys` is given, the `data-key`s of the
 * elements matching `keysSelector` are exactly `keys`, in order.
 */
export type DoneWhen = { selector: string; keys?: string[]; keysSelector?: string };

type Armed = { trigger: 'click' | 'keydown'; done: DoneWhen | null };

/**
 * Prepares one in-page latency measurement. Starts at the `trigger` event's
 * own timestamp (when the browser created the click or key event), so the
 * test runner's messaging is not counted. It ends when the DOM reflects the
 * interaction (`done` holds after a mutation, checked in a MutationObserver
 * callback; `null`: once the `input` event's handlers and the microtasks they
 * queued have run), plus a forced style and layout pass, so rendering work
 * Svelte left to the browser is counted too. Waiting for the next frame is
 * not counted: that is the display's cadence, not the app's work.
 */
const arm = (page: Page, a: Armed) =>
  page.evaluate(({ trigger, done }) => {
    const w = window as unknown as { __threadgardenPerf?: Promise<number> };
    const holds = (d: DoneWhen): boolean => {
      if (!document.querySelector(d.selector)) return false;
      if (!d.keys) return true;
      const got = [...document.querySelectorAll(d.keysSelector ?? '[data-key]')].map((e) =>
        e.getAttribute('data-key'),
      );
      return got.length === d.keys.length && got.every((k, i) => k === d.keys![i]);
    };
    if (done && holds(done))
      throw new Error(`already done before the interaction: ${done.selector}`);
    w.__threadgardenPerf = new Promise<number>((resolve, reject) => {
      let t0: number | null = null;
      const finish = () => {
        void document.documentElement.offsetHeight; // style + layout
        resolve(performance.now() - t0!);
      };
      const timeout = setTimeout(() => reject(new Error('interaction never completed')), 10_000);
      window.addEventListener(
        trigger,
        (e) => {
          t0 = e.timeStamp;
          if (done) {
            const mo = new MutationObserver(() => {
              if (!holds(done)) return;
              mo.disconnect();
              clearTimeout(timeout);
              finish();
            });
            mo.observe(document.body, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          } else {
            // After the input's own handlers (this window listener runs last)
            // and the microtasks they queued: Svelte flushes its updates in a
            // microtask queued before ours. Not a new task: Chrome may render
            // a frame first, and the wait for it is not the app's work.
            const settle = () => {
              void Promise.resolve()
                .then(() => undefined)
                .then(() => {
                  clearTimeout(timeout);
                  finish();
                });
            };
            window.addEventListener('input', settle, { once: true });
          }
        },
        { capture: true, once: true },
      );
    });
  }, a);

const result = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as { __threadgardenPerf: Promise<number> }).__threadgardenPerf,
  );

/** Milliseconds from a real click to `done` (see `arm`). */
export const timeClick = async (
  page: Page,
  click: () => Promise<void>,
  done: DoneWhen,
): Promise<number> => {
  await arm(page, { trigger: 'click', done });
  await click();
  return result(page);
};

/** Milliseconds from a real key press to `done`, or to the input settling when `done` is null. */
export const timeKey = async (
  page: Page,
  press: () => Promise<void>,
  done: DoneWhen | null,
): Promise<number> => {
  await arm(page, { trigger: 'keydown', done });
  await press();
  return result(page);
};

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(', ');

/**
 * The chat list row of `sessionId`, scrolled into the DOM first: the list is
 * virtual (and has section headers), so a row further down is not rendered
 * until the list scrolls near it. Scrolls down a viewport at a time.
 */
export const chatRow = async (page: Page, sessionId: string): Promise<Locator> => {
  const list = page.getByRole('region', { name: 'Chat list' });
  const row = list.locator(`[role="option"][data-session-id="${sessionId}"]`);
  const box = list.getByRole('listbox');
  await expect(box).toBeVisible();
  await expect
    .poll(
      async () => {
        if ((await row.count()) > 0) return true;
        await box.evaluate((el) => (el.scrollTop += el.clientHeight * 0.8));
        return false;
      },
      { message: `chat list row ${sessionId}`, intervals: [50] },
    )
    .toBe(true);
  await row.scrollIntoViewIfNeeded();
  return row;
};

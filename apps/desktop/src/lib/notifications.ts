/**
 * Getting the user's attention (spec §6.2): an OS notification when a chat
 * starts needing the user, or finishes a turn ("Your turn", v1.1 §3), and they
 * are not looking at it; the tray badge with the number of chats waiting (the
 * service counts unread chats in it); and the window's focus reported to the
 * service (`ui.visibility`, which paces external-session polling).
 *
 * v1.3 B: "Scheduled message sent to ‹title›" when a scheduled send goes out
 * (the notifications setting; saying so when it went out late).
 *
 * v1.2 §3: "‹title› is back from hold" when a hold runs out (`chatBackFromHold`,
 * same setting and focus rule as Needs you). Holds that end together (a bulk
 * hold) are one notification, "‹title› and N more are back from hold". The
 * service announces a hold only to connected windows, so on every connect the
 * chats back from hold that were never announced are, the same way. Each is
 * announced once, also across restarts: the announced ids are kept in
 * `uiState`, and an id is forgotten only once its chat is idle and no longer
 * back from hold (seen, or moved), so its next hold is announced again.
 *
 * Marking a finished chat seen is `YourTurnState`'s job.
 *
 * The notification plugin cannot report clicks (ruling R26). Clicking a
 * notification focuses Threadgarden, so when the window gains focus within
 * `FOCUS_OPENS_WITHIN_MS` of a notification, Threadgarden selects "Needs you" and
 * opens the waiting chat if it is the only one.
 */
import type { ChatStatus, ChatSummary } from '@threadgarden/protocol';
import { baseName } from './components/layout/chat-info';
import { notify as nativeNotify, setTrayNeedsYou as nativeSetTray } from './native';
import { quietly, type Api } from './state/api';
import type { PlacesState } from './state/places.svelte';
import type { SettingsState } from './state/settings.svelte';
import type { MachineTabs } from './state/tabs.svelte';

export const FOCUS_OPENS_WITHIN_MS = 30_000;

/** `uiState` key: the chats whose return from hold was announced (v1.2 §3). */
export const HOLDS_ANNOUNCED_KEY = 'holds.announced';
/** Chats under Needs you read on connect to find unannounced returns from hold. */
const BACK_FROM_HOLD_LIMIT = 200;
/** Holds ending within this long of each other are announced together. */
export const BACK_FROM_HOLD_BATCH_MS = 500;
/** "Back from hold" reads false while a chat is in use (B1); such a chat is not forgotten. */
const IN_USE: ReadonlySet<ChatStatus> = new Set(['needsYou', 'working']);

export type AttentionDeps = {
  api: Api;
  settings: Pick<SettingsState, 'value'>;
  /** The machine's view of the tabs (session ids of that machine). */
  tabs: Pick<MachineTabs, 'active' | 'openTab'>;
  places: Pick<PlacesState, 'select' | 'subscribeCounts' | 'projects'>;
  notify?: typeof nativeNotify;
  setTrayNeedsYou?: typeof nativeSetTray;
  now?: () => number;
  win?: Window;
  /** How long live returns from hold are gathered into one notification (tests shorten it). */
  backFromHoldBatchMs?: number;
};

/** Starts watching; returns a function that stops. */
export const startAttention = (deps: AttentionDeps): (() => void) => {
  const { api, settings, tabs, places } = deps;
  const notify = deps.notify ?? nativeNotify;
  const setTray = deps.setTrayNeedsYou ?? nativeSetTray;
  const now = deps.now ?? Date.now;
  const win = deps.win ?? window;
  const doc = win.document;

  let focused = doc.visibilityState !== 'hidden' && doc.hasFocus();
  let reported: boolean | null = null;
  let notified: { sessionId: string; at: number } | null = null;
  let badge = -1;

  const report = (force = false): void => {
    if (!force && reported === focused) return;
    if (api.status !== 'open') return; // sent again on the next hello
    reported = focused;
    quietly(api.request('ui.visibility', { visible: focused }));
  };

  /** The user came back soon after a notification: show what is waiting. */
  const openNotified = async (): Promise<void> => {
    const n = notified;
    notified = null;
    if (!n || now() - n.at > FOCUS_OPENS_WITHIN_MS) return;
    // Finished chats are listed there too, below the ones waiting on an answer.
    places.select({ kind: 'needsYou' });
    const { items } = await api.request('sessions.list', {
      place: { kind: 'needsYou' },
      limit: 2,
    });
    if (items.length === 1) tabs.openTab(items[0]!.sessionId);
  };

  const onFocus = (): void => {
    focused = true;
    report();
    quietly(openNotified());
  };
  const onBlur = (): void => {
    focused = false;
    report();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onBlur();
  };

  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  // ── v1.2 §3: back from hold ──
  type Back = { sessionId: string; title: string; projectName: string };
  const batchMs = deps.backFromHoldBatchMs ?? BACK_FROM_HOLD_BATCH_MS;
  /**
   * The announced ids. Live announcements are added at once (so a connect-time
   * catch-up running meanwhile does not repeat them); the stored ones are
   * merged in on first use.
   */
  const announced = new Set<string>();
  let loaded = false;
  /** Reads and writes of the stored ids run one at a time, in order. */
  let chain: Promise<void> = Promise.resolve();
  const serially = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch(() => {});
  };
  const load = async (): Promise<void> => {
    if (loaded) return;
    const { value } = await api.request('uiState.get', { key: HOLDS_ANNOUNCED_KEY });
    for (const v of Array.isArray(value) ? value : []) {
      if (typeof v === 'string') announced.add(v);
    }
    loaded = true;
  };
  const save = async (): Promise<void> => {
    await api.request('uiState.set', { key: HOLDS_ANNOUNCED_KEY, value: [...announced] });
  };
  const visible = (sessionId: string): boolean => focused && tabs.active === sessionId;
  const projectName = (s: Pick<ChatSummary, 'projectId' | 'cwd'>): string =>
    places.projects.find((p) => p.projectId === s.projectId)?.displayName ?? baseName(s.cwd);

  /** One notification for chats back from hold (those on screen left out). */
  const post = (chats: readonly Back[], enabled: boolean): void => {
    const shown = chats.filter((c) => !visible(c.sessionId));
    const first = shown[0];
    if (!enabled || !first) return;
    notified = { sessionId: first.sessionId, at: now() };
    const title =
      shown.length === 1
        ? `${first.title} is back from hold`
        : `${first.title} and ${shown.length - 1} more are back from hold`;
    quietly(notify(title, shown.length === 1 ? first.projectName : '', first.sessionId));
  };

  /** Live returns gathered for one notification and one save. */
  let pending: Back[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  const flushPending = (): void => {
    batchTimer = undefined;
    const batch = pending;
    pending = [];
    post(batch, settings.value.notifications);
    serially(async () => {
      await load();
      await save();
    });
  };

  /** Holds that ran out while no window listened: announced once, like live ones. */
  const catchUp = async (): Promise<void> => {
    const [, needsYou, current] = await Promise.all([
      load(),
      api.request('sessions.list', { place: { kind: 'needsYou' }, limit: BACK_FROM_HOLD_LIMIT }),
      // Settings may not be loaded yet on the first connect.
      api.request('settings.get', {}).catch(() => settings.value),
    ]);
    // Ids missing from the list are kept: the chat may be busy, or beyond the list's end.
    const fresh = needsYou.items.filter(
      (s) => s.backFromHold === true && !announced.has(s.sessionId),
    );
    if (fresh.length === 0) return;
    for (const s of fresh) announced.add(s.sessionId);
    await save();
    post(
      fresh.map((s) => ({ sessionId: s.sessionId, title: s.title, projectName: projectName(s) })),
      current.notifications,
    );
  };

  /**
   * Announced chats that changed: forget the idle ones no longer back from
   * hold, and any put on hold again (busy or not), so that hold's end is
   * announced too.
   */
  const prune = async (sessionIds: string[]): Promise<void> => {
    await load();
    const ids = sessionIds.filter((id) => announced.has(id));
    if (ids.length === 0) return;
    const { items } = await api.request('sessions.summaries', { sessionIds: ids });
    const byId = new Map(items.map((s) => [s.sessionId, s]));
    const gone = ids.filter((id) => {
      const s = byId.get(id);
      return !s || s.bucket === 'onHold' || (!s.backFromHold && !IN_USE.has(s.status));
    });
    if (gone.length === 0) return;
    for (const id of gone) announced.delete(id);
    await save();
  };

  const offs = [
    api.onOpen(() => report(true)),
    api.onOpen(() => serially(catchUp)),
    api.on('chatBackFromHold', (e) => {
      announced.add(e.sessionId);
      pending.push(e);
      batchTimer ??= setTimeout(flushPending, batchMs);
    }),
    api.on('sessions.changed', (e) => {
      if (e.sessionIds.some((id) => announced.has(id))) serially(() => prune(e.sessionIds));
    }),
    api.on('needsYou', (e) => {
      if (!settings.value.notifications) return;
      // Already in front of the user: the chat is the active tab of a focused window.
      if (focused && tabs.active === e.sessionId) return;
      notified = { sessionId: e.sessionId, at: now() };
      quietly(notify(e.title, `${e.projectName} · ${e.what}`, e.sessionId));
    }),
    // v1.3 B: a scheduled message went out (the notifications setting, like Needs you).
    api.on('scheduledSent', (e) => {
      if (!settings.value.notifications) return;
      if (focused && tabs.active === e.sessionId) return;
      notified = { sessionId: e.sessionId, at: now() };
      const body = e.late
        ? `${e.projectName ? `${e.projectName} · ` : ''}sent late: Threadgarden was not running when it was due`
        : e.projectName;
      quietly(notify(`Scheduled message sent to ${e.title}`, body, e.sessionId));
    }),
    api.on('chatFinished', (e) => {
      if (!settings.value.notifyOnFinish) return;
      if (focused && tabs.active === e.sessionId) return;
      notified = { sessionId: e.sessionId, at: now() };
      quietly(notify(`${e.title} finished — your turn`, e.projectName, e.sessionId));
    }),
    places.subscribeCounts((counts) => {
      if (counts.needsYou === badge) return;
      badge = counts.needsYou;
      quietly(setTray(badge));
    }),
  ];
  report(true);
  if (api.status === 'open') serially(catchUp);

  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    for (const off of offs) off();
    clearTimeout(batchTimer);
  };
};

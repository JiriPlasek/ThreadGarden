/**
 * Getting the user's attention (spec §6.2): an OS notification when a chat
 * starts needing the user, or finishes a turn ("Your turn", v1.1 §3), and they
 * are not looking at it; the tray badge with the number of chats waiting (the
 * service counts unread chats in it); and the window's focus reported to the
 * service (`ui.visibility`, which paces external-session polling).
 *
 * v1.2 §3: "‹title› is back from hold" when a hold runs out (`chatBackFromHold`,
 * same setting and focus rule as Needs you). The service announces a hold
 * only to connected windows, so on every connect the chats back from hold
 * that were never announced are (once, also across restarts: the announced
 * ids are kept in `uiState`, and forgotten once a chat is no longer back
 * from hold, so its next hold is announced again).
 *
 * Marking a finished chat seen is `YourTurnState`'s job.
 *
 * The notification plugin cannot report clicks (ruling R26). Clicking a
 * notification focuses pahub, so when the window gains focus within
 * `FOCUS_OPENS_WITHIN_MS` of a notification, pahub selects "Needs you" and
 * opens the waiting chat if it is the only one.
 */
import { notify as nativeNotify, setTrayNeedsYou as nativeSetTray } from './native';
import { quietly, type Api } from './state/api';
import type { PlacesState } from './state/places.svelte';
import type { SettingsState } from './state/settings.svelte';
import type { TabsState } from './state/tabs.svelte';

export const FOCUS_OPENS_WITHIN_MS = 30_000;

/** `uiState` key: the chats whose return from hold was announced (v1.2 §3). */
export const HOLDS_ANNOUNCED_KEY = 'holds.announced';
/** Chats under Needs you read on connect to find unannounced returns from hold. */
const BACK_FROM_HOLD_LIMIT = 200;

export type AttentionDeps = {
  api: Api;
  settings: Pick<SettingsState, 'value'>;
  tabs: Pick<TabsState, 'active' | 'openTab'>;
  places: Pick<PlacesState, 'select' | 'subscribeCounts' | 'projects'>;
  notify?: typeof nativeNotify;
  setTrayNeedsYou?: typeof nativeSetTray;
  now?: () => number;
  win?: Window;
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
  /** The announced ids; null until read from `uiState` (re-read on every connect). */
  let announced: Set<string> | null = null;
  /** Reads and writes of `announced` run one at a time, in order. */
  let chain: Promise<void> = Promise.resolve();
  const serially = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch(() => {});
  };
  const storedIds = async (): Promise<string[]> => {
    const { value } = await api.request('uiState.get', { key: HOLDS_ANNOUNCED_KEY });
    return (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string');
  };
  const save = async (ids: Set<string>): Promise<void> => {
    await api.request('uiState.set', { key: HOLDS_ANNOUNCED_KEY, value: [...ids] });
  };
  const visible = (sessionId: string): boolean => focused && tabs.active === sessionId;

  /** Holds that ran out while no window listened: announce them once. */
  const catchUp = async (): Promise<void> => {
    const [stored, needsYou, current] = await Promise.all([
      storedIds(),
      api.request('sessions.list', { place: { kind: 'needsYou' }, limit: BACK_FROM_HOLD_LIMIT }),
      // Settings may not be loaded yet on the first connect.
      api.request('settings.get', {}).catch(() => settings.value),
    ]);
    const known = new Set([...stored, ...(announced ?? [])]);
    const back = needsYou.items.filter((s) => s.backFromHold === true);
    const fresh = back.filter((s) => !known.has(s.sessionId));
    // Ids no longer back from hold are forgotten; the fresh ones are remembered.
    const next = new Set([
      ...back.filter((s) => known.has(s.sessionId)).map((s) => s.sessionId),
      ...fresh.map((s) => s.sessionId),
    ]);
    announced = next;
    if (next.size !== known.size || fresh.length > 0) await save(next);
    const shown = fresh.filter((s) => !visible(s.sessionId));
    const first = shown[0];
    if (!current.notifications || !first) return;
    notified = { sessionId: first.sessionId, at: now() };
    const title =
      shown.length === 1
        ? `${first.title} is back from hold`
        : `${first.title} and ${shown.length - 1} more are back from hold`;
    // A list summary carries the project id; the name is known once projects are loaded.
    const project = places.projects.find((p) => p.projectId === first.projectId);
    quietly(notify(title, shown.length === 1 ? (project?.displayName ?? '') : '', first.sessionId));
  };

  /** Chats that changed and were announced: forget the ones no longer back from hold. */
  const prune = async (sessionIds: string[]): Promise<void> => {
    if (!announced) return;
    const ids = sessionIds.filter((id) => announced!.has(id));
    if (ids.length === 0) return;
    const { items } = await api.request('sessions.summaries', { sessionIds: ids });
    const still = new Set(items.filter((s) => s.backFromHold === true).map((s) => s.sessionId));
    const gone = ids.filter((id) => !still.has(id));
    if (gone.length === 0) return;
    for (const id of gone) announced.delete(id);
    await save(announced);
  };

  const offs = [
    api.onOpen(() => report(true)),
    api.onOpen(() => serially(catchUp)),
    api.on('chatBackFromHold', (e) => {
      serially(async () => {
        // Not read yet (the connect-time read failed): keep what is stored.
        announced ??= new Set(await storedIds());
        announced.add(e.sessionId);
        await save(announced);
      });
      if (!settings.value.notifications) return;
      if (visible(e.sessionId)) return;
      notified = { sessionId: e.sessionId, at: now() };
      quietly(notify(`${e.title} is back from hold`, e.projectName, e.sessionId));
    }),
    api.on('sessions.changed', (e) => {
      if (announced && e.sessionIds.some((id) => announced!.has(id))) {
        serially(() => prune(e.sessionIds));
      }
    }),
    api.on('needsYou', (e) => {
      if (!settings.value.notifications) return;
      // Already in front of the user: the chat is the active tab of a focused window.
      if (focused && tabs.active === e.sessionId) return;
      notified = { sessionId: e.sessionId, at: now() };
      quietly(notify(e.title, `${e.projectName} · ${e.what}`, e.sessionId));
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
  };
};

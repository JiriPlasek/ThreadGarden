/**
 * Getting the user's attention (spec §6.2): an OS notification when a chat
 * starts needing the user and they are not looking at it, the tray badge with
 * the number of chats waiting, and the window's focus reported to the service
 * (`ui.visibility`, which paces external-session polling).
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

export type AttentionDeps = {
  api: Api;
  settings: Pick<SettingsState, 'value'>;
  tabs: Pick<TabsState, 'active' | 'openTab'>;
  places: Pick<PlacesState, 'select' | 'subscribeCounts'>;
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

  const offs = [
    api.onOpen(() => report(true)),
    api.on('needsYou', (e) => {
      if (!settings.value.notifications) return;
      // Already in front of the user: the chat is the active tab of a focused window.
      if (focused && tabs.active === e.sessionId) return;
      notified = { sessionId: e.sessionId, at: now() };
      quietly(notify(e.title, `${e.projectName} · ${e.what}`, e.sessionId));
    }),
    places.subscribeCounts((counts) => {
      if (counts.needsYou === badge) return;
      badge = counts.needsYou;
      quietly(setTray(badge));
    }),
  ];
  report(true);

  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    for (const off of offs) off();
  };
};

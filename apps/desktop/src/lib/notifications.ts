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
 * opens the waiting chat if it is the only one (on any machine), unless every
 * notification was about the open chat: that one is in front already, so the
 * place stays.
 *
 * Remote machines: every machine's scope gets a watcher of its own (started
 * when the machine appears, stopped when it goes), so every machine's chats
 * notify; a notification is known by its chat key (`machineId/sessionId`), and
 * with more than one machine one from another machine names it first
 * ("Ubuntu PC · tg-cli · needs permission"). The window's focus, the
 * notification click and the tray badge are watched once: the badge shows This
 * PC's Needs you count, which already adds up every machine's.
 */
import type { ChatStatus, ChatSummary } from '@threadgarden/protocol';
import { baseName } from './components/layout/chat-info';
import { notify as nativeNotify, setTrayNeedsYou as nativeSetTray } from './native';
import { quietly } from './state/api';
import { machineLabel, type MachinesState } from './state/machines.svelte';
import type { PlacesState } from './state/places.svelte';
import { chatKey, type ChatRef } from './state/refs';
import type { MachineScope, Scopes } from './state/scope';
import type { SettingsState } from './state/settings.svelte';
import type { TabsState } from './state/tabs.svelte';

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
  /** Every machine's stores: one watcher per scope, for as long as the scope is there. */
  scopes: Pick<Scopes, 'observe' | 'all' | 'local'>;
  /** Names the machine of a notification from another machine. */
  machines: Pick<MachinesState, 'get' | 'several'>;
  settings: Pick<SettingsState, 'value'>;
  /** The tabs (chat keys). */
  tabs: Pick<TabsState, 'active' | 'openTab'>;
  /**
   * This PC's places: where a notification click selects Needs you, and the
   * tray count (Needs you summed across machines).
   */
  places: Pick<PlacesState, 'select' | 'subscribeCounts'>;
  notify?: typeof nativeNotify;
  setTrayNeedsYou?: typeof nativeSetTray;
  now?: () => number;
  win?: Window;
  /** How long live returns from hold are gathered into one notification (tests shorten it). */
  backFromHoldBatchMs?: number;
};

/** Starts watching every machine; returns a function that stops. */
export const startAttention = (deps: AttentionDeps): (() => void) => {
  const { scopes, tabs, places } = deps;
  const setTray = deps.setTrayNeedsYou ?? nativeSetTray;
  const now = deps.now ?? Date.now;
  const win = deps.win ?? window;
  const doc = win.document;

  const shared: AttentionShared = {
    focused: doc.visibilityState !== 'hidden' && doc.hasFocus(),
    notifiedAt: null,
    notified: new Set(),
    reporters: new Set(),
  };
  let badge = -1;

  /** The user came back soon after a notification: show what is waiting, on every machine. */
  const openNotified = async (): Promise<void> => {
    const at = shared.notifiedAt;
    const about = shared.notified;
    shared.notifiedAt = null;
    shared.notified = new Set();
    if (at === null || now() - at > FOCUS_OPENS_WITHIN_MS) return;
    // Every notification was about the open chat: it is in front now, so the place stays.
    if (tabs.active !== null && [...about].every((key) => key === tabs.active)) return;
    // Finished chats are listed there too, below the ones waiting on an answer.
    places.select({ kind: 'needsYou' });
    // A machine that cannot answer is left out; the others still count.
    const lists = await Promise.allSettled(
      scopes
        .all()
        .filter((s) => s.api.status === 'open')
        .map(async (s): Promise<ChatRef[]> => {
          const { items } = await s.api.request('sessions.list', {
            place: { kind: 'needsYou' },
            limit: 2,
          });
          return items.map((c) => ({ machineId: s.machineId, sessionId: c.sessionId }));
        }),
    );
    const waiting = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (waiting.length === 1) tabs.openTab(waiting[0]!);
  };

  const reportAll = (): void => {
    for (const report of shared.reporters) report();
  };
  const onFocus = (): void => {
    shared.focused = true;
    reportAll();
    quietly(openNotified());
  };
  const onBlur = (): void => {
    shared.focused = false;
    reportAll();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onBlur();
  };

  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  const offScopes = scopes.observe((scope) => watch(scope, deps, shared));
  const offTray = places.subscribeCounts((counts) => {
    if (counts.needsYou === badge) return;
    badge = counts.needsYou;
    quietly(setTray(badge));
  });

  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    offScopes();
    offTray();
  };
};

/** What the watchers of every machine share: the window's focus and the last notification. */
type AttentionShared = {
  focused: boolean;
  /** When the last notification went out (any machine's), until the window is focused. */
  notifiedAt: number | null;
  /** The chats (keys) notified about since the window was last focused. */
  notified: Set<string>;
  /** Each machine's `ui.visibility` reporter, run when the focus changes. */
  reporters: Set<(force?: boolean) => void>;
};

/** One machine's notifications; returns a function that stops them. */
const watch = (scope: MachineScope, deps: AttentionDeps, shared: AttentionShared): (() => void) => {
  const { api, places } = scope;
  const { settings, tabs, machines } = deps;
  const notify = deps.notify ?? nativeNotify;
  const now = deps.now ?? Date.now;
  const local = scope === deps.scopes.local();

  let reported: boolean | null = null;
  const report = (force = false): void => {
    if (!force && reported === shared.focused) return;
    if (api.status !== 'open') return; // sent again on the next hello
    reported = shared.focused;
    quietly(api.request('ui.visibility', { visible: shared.focused }));
  };
  shared.reporters.add(report);

  const keyOf = (sessionId: string): string => chatKey({ machineId: scope.machineId, sessionId });
  /** The chat is the active tab of a focused window: already in front of the user. */
  const visible = (sessionId: string): boolean =>
    shared.focused && tabs.active === keyOf(sessionId);
  /** With more than one machine, another machine's notification names it first. */
  const body = (text: string): string => {
    const m = local || !machines.several ? undefined : machines.get(scope.machineId);
    if (!m) return text;
    return text ? `${machineLabel(m)} · ${text}` : machineLabel(m);
  };
  const say = (title: string, text: string, sessionId: string): void => {
    shared.notifiedAt = now();
    shared.notified.add(keyOf(sessionId));
    quietly(notify(title, body(text), keyOf(sessionId)));
  };

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
  const projectName = (s: Pick<ChatSummary, 'projectId' | 'cwd'>): string =>
    places.projects.find((p) => p.projectId === s.projectId)?.displayName ?? baseName(s.cwd);

  /** One notification for chats back from hold (those on screen left out). */
  const post = (chats: readonly Back[], enabled: boolean): void => {
    const shown = chats.filter((c) => !visible(c.sessionId));
    const first = shown[0];
    if (!enabled || !first) return;
    const title =
      shown.length === 1
        ? `${first.title} is back from hold`
        : `${first.title} and ${shown.length - 1} more are back from hold`;
    say(title, shown.length === 1 ? first.projectName : '', first.sessionId);
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
      // Settings (This PC's) may not be loaded yet on the first connect.
      deps.scopes
        .local()
        .api.request('settings.get', {})
        .catch(() => settings.value),
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
      if (visible(e.sessionId)) return;
      say(e.title, `${e.projectName} · ${e.what}`, e.sessionId);
    }),
    // v1.3 B: a scheduled message went out (the notifications setting, like Needs you).
    api.on('scheduledSent', (e) => {
      if (!settings.value.notifications) return;
      if (visible(e.sessionId)) return;
      const text = e.late
        ? `${e.projectName ? `${e.projectName} · ` : ''}sent late: Threadgarden was not running when it was due`
        : e.projectName;
      say(`Scheduled message sent to ${e.title}`, text, e.sessionId);
    }),
    api.on('chatFinished', (e) => {
      if (!settings.value.notifyOnFinish) return;
      if (visible(e.sessionId)) return;
      say(`${e.title} finished — your turn`, e.projectName, e.sessionId);
    }),
  ];
  report(true);
  if (api.status === 'open') serially(catchUp);

  return () => {
    shared.reporters.delete(report);
    for (const off of offs) off();
    clearTimeout(batchTimer);
  };
};

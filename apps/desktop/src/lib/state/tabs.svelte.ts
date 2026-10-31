import { quietly, type Api } from './api';
import { chatKey, LOCAL_FALLBACK_ID, parseChatKey, type ChatRef } from './refs';

export const TABS_KEY = 'tabs';
/** Stored on the local service (the layout belongs to this desktop): chat keys since remote machines. */
type Persisted = { open: string[]; active: string | null };

/**
 * One machine's view of the tabs: the session ids of its open tabs, and of the
 * active tab when that one is on this machine. What a scope's stores need.
 */
export type MachineTabs = {
  readonly open: string[];
  readonly active: string | null;
  openTab(sessionId: string): void;
};

export type TabsOptions = {
  /** This PC's machine id (known after the local service's first `hello`). */
  localMachineId?: () => string;
};

export class TabsState {
  /** Chat keys (`machineId/sessionId`, see `refs.ts`) in tab order. */
  open = $state<string[]>([]);
  /** The chat key on screen; null when none is (no tabs, or the Analytics view is shown). */
  active = $state<string | null>(null);
  restored = $state(false);
  /**
   * v1.3 analytics: the Analytics view has a tab of its own in the tab bar
   * (not a chat, so not in `open` and not remembered across restarts), and
   * `analyticsShown` while it fills the main pane instead of a chat.
   */
  analyticsOpen = $state(false);
  analyticsShown = $state(false);
  /** The chat that was active when the Analytics view was shown: it comes back after. */
  private behindAnalytics: string | null = null;

  private api: Api | null = null;
  private localId: () => string = () => LOCAL_FALLBACK_ID;
  private readonly subscribers = new Set<() => void>();

  init = (api: Api, opts: TabsOptions = {}): void => {
    this.api = api;
    if (opts.localMachineId) this.localId = opts.localMachineId;
  };

  /** This PC's machine id (`'local'` until the local service said). */
  localMachineId = (): string => this.localId();

  /** Called after the set of open tabs or the active tab changed. */
  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  /**
   * The key of a chat. A string is taken as a chat key when it is one, else
   * (until every caller passes a `ChatRef`) as a session id on This PC.
   */
  keyOf = (chat: ChatRef | string): string =>
    typeof chat !== 'string'
      ? chatKey(chat)
      : parseChatKey(chat)
        ? chat
        : chatKey({ machineId: this.localMachineId(), sessionId: chat });

  /** The tabs as `machineId` sees them (`machineId` is read on every use: This PC's is learnt late). */
  on = (machineId: () => string): MachineTabs => {
    const sessionIdOn = (key: string | null): string | null => {
      const ref = key === null ? null : parseChatKey(key);
      return ref && ref.machineId === machineId() ? ref.sessionId : null;
    };
    const open = (): string[] =>
      this.open.map(sessionIdOn).filter((id): id is string => id !== null);
    const active = (): string | null => sessionIdOn(this.active);
    return {
      get open() {
        return open();
      },
      get active() {
        return active();
      },
      openTab: (sessionId) => this.openTab({ machineId: machineId(), sessionId }),
    };
  };

  /**
   * Loads the persisted layout from the service (`uiState`). Entries stored
   * before remote machines (bare session ids), and keys made while This PC's id
   * was not known (`local/…`), are This PC's.
   */
  restore = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: TABS_KEY });
      const v = value as Partial<Persisted> | null;
      if (v && Array.isArray(v.open)) {
        const keys = v.open.filter((x): x is string => typeof x === 'string').map(this.storedKey);
        this.open = [...new Set(keys)];
        const active = typeof v.active === 'string' ? this.storedKey(v.active) : null;
        this.active =
          active !== null && this.open.includes(active) ? active : (this.open[0] ?? null);
      }
    } catch {
      // Start with no tabs; the layout is a convenience.
    }
    this.restored = true;
    this.changed(false);
  };

  openTab = (chat: ChatRef | string): void => {
    const key = this.keyOf(chat);
    if (!this.open.includes(key)) this.open = [...this.open, key];
    this.analyticsShown = false;
    this.active = key;
    this.changed();
  };

  activate = (chat: ChatRef | string): void => {
    const key = this.keyOf(chat);
    if (!this.open.includes(key) || this.active === key) return;
    this.analyticsShown = false;
    this.active = key;
    this.changed();
  };

  close = (chat: ChatRef | string): void => {
    if (this.remove(this.keyOf(chat))) this.changed();
  };

  /** Closes the tabs of every machine not in `machineIds` (they were removed meanwhile). */
  keepMachines = (machineIds: ReadonlySet<string>): void => {
    const keys = this.open.filter((k) => {
      const id = parseChatKey(k)?.machineId;
      return id !== undefined && !machineIds.has(id);
    });
    for (const key of keys) this.remove(key);
    if (keys.length > 0) this.changed();
  };

  /** Closes every tab of a machine (it was removed). */
  closeMachine = (machineId: string): void => {
    const keys = this.open.filter((k) => parseChatKey(k)?.machineId === machineId);
    for (const key of keys) this.remove(key);
    if (keys.length > 0) this.changed();
  };

  /** Opens (or switches to) the Analytics view; the active chat steps aside until it closes. */
  showAnalytics = (): void => {
    if (this.analyticsShown) return;
    this.behindAnalytics = this.active;
    this.analyticsOpen = true;
    this.analyticsShown = true;
    this.active = null;
    this.changed();
  };

  /** Closes the Analytics tab; if it was on screen, the chat behind it comes back. */
  closeAnalytics = (): void => {
    if (!this.analyticsOpen) return;
    this.analyticsOpen = false;
    if (this.analyticsShown) {
      this.analyticsShown = false;
      this.active = this.behindAnalytics ?? this.open.at(-1) ?? null;
    }
    this.behindAnalytics = null;
    this.changed();
  };

  move = (chat: ChatRef | string, toIndex: number): void => {
    const key = this.keyOf(chat);
    if (!this.open.includes(key)) return;
    const next = this.open.filter((x) => x !== key);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, key);
    this.open = next;
    this.changed();
  };

  /** A stored entry's key now: the `local` fallback becomes This PC's real id. */
  private storedKey = (stored: string): string => {
    const ref = parseChatKey(stored);
    return ref?.machineId === LOCAL_FALLBACK_ID
      ? chatKey({ machineId: this.localId(), sessionId: ref.sessionId })
      : this.keyOf(stored);
  };

  /** Drops the tab of `key` (without notifying); false when it was not open. */
  private remove = (key: string): boolean => {
    const i = this.open.indexOf(key);
    if (i < 0) return false;
    this.open = this.open.filter((x) => x !== key);
    if (this.active === key) {
      this.active = this.open[Math.min(i, this.open.length - 1)] ?? null;
    }
    if (this.behindAnalytics === key) {
      this.behindAnalytics = this.open[Math.min(i, this.open.length - 1)] ?? null;
    }
    return true;
  };

  private changed = (persist = true): void => {
    if (persist && this.api) {
      // Behind the Analytics view, the chat it covers is still the one to restore.
      const active = this.analyticsShown ? this.behindAnalytics : this.active;
      const value: Persisted = { open: [...this.open], active };
      quietly(this.api.request('uiState.set', { key: TABS_KEY, value }));
    }
    for (const cb of this.subscribers) cb();
  };
}

export const tabs = new TabsState();

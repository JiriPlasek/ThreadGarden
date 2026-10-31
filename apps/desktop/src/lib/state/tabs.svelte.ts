import { quietly, type Api } from './api';

export const TABS_KEY = 'tabs';
type Persisted = { open: string[]; active: string | null };

export class TabsState {
  open = $state<string[]>([]);
  /** The chat on screen; null when none is (no tabs, or the Analytics view is shown). */
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
  private readonly subscribers = new Set<() => void>();

  init = (api: Api): void => {
    this.api = api;
  };

  /** Called after the set of open tabs or the active tab changed. */
  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  /** Loads the persisted layout from the service (`uiState`). */
  restore = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: TABS_KEY });
      const v = value as Partial<Persisted> | null;
      if (v && Array.isArray(v.open)) {
        this.open = [...new Set(v.open.filter((x): x is string => typeof x === 'string'))];
        this.active =
          typeof v.active === 'string' && this.open.includes(v.active)
            ? v.active
            : (this.open[0] ?? null);
      }
    } catch {
      // Start with no tabs; the layout is a convenience.
    }
    this.restored = true;
    this.changed(false);
  };

  openTab = (sessionId: string): void => {
    if (!this.open.includes(sessionId)) this.open = [...this.open, sessionId];
    this.analyticsShown = false;
    this.active = sessionId;
    this.changed();
  };

  activate = (sessionId: string): void => {
    if (!this.open.includes(sessionId) || this.active === sessionId) return;
    this.analyticsShown = false;
    this.active = sessionId;
    this.changed();
  };

  close = (sessionId: string): void => {
    const i = this.open.indexOf(sessionId);
    if (i < 0) return;
    this.open = this.open.filter((x) => x !== sessionId);
    if (this.active === sessionId) {
      this.active = this.open[Math.min(i, this.open.length - 1)] ?? null;
    }
    if (this.behindAnalytics === sessionId) {
      this.behindAnalytics = this.open[Math.min(i, this.open.length - 1)] ?? null;
    }
    this.changed();
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

  move = (sessionId: string, toIndex: number): void => {
    if (!this.open.includes(sessionId)) return;
    const next = this.open.filter((x) => x !== sessionId);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, sessionId);
    this.open = next;
    this.changed();
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

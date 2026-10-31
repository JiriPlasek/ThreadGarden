/**
 * "Your turn" (v1.1 §3): the service marks a chat unread whenever one of its
 * turns ends; only the UI knows whether the user was looking. A chat counts as
 * seen while it is the active tab of a focused window, so:
 *
 * - `chatFinished` for the chat on screen is marked seen at once (keeps the
 *   unread flash in the lists as short as possible);
 * - a chat that becomes the active tab of a focused window (opened, tab
 *   switched, window focused) is marked seen when it is known to be unread,
 *   debounced so tabs only passed through (Ctrl+Tab) stay unread.
 *
 * v1.2 "Back from hold" works the same way: a chat whose hold ran out counts
 * as unread here, so viewing it calls `chat.markSeen`, which clears the flag
 * (the service does not clear it on `chat.open`, which reconnects repeat).
 *
 * "Known to be unread" reads every summary the UI already has: the chat list,
 * the agents strip (whose Needs you fetch spans every project), the open
 * chat's own summary and the tab's peek, plus the finishes seen here. All
 * reactive, so a summary that arrives after the tab opened still counts.
 */
import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { AgentsState } from './agents.svelte';
import { quietly, type Api } from './api';
import type { ChatsState } from './chats.svelte';
import type { SessionsState } from './sessions.svelte';
import type { TabsState } from './tabs.svelte';

/** How long a chat must stay on screen before it counts as seen. */
export const SEEN_DEBOUNCE_MS = 400;

export type YourTurnDeps = {
  tabs: Pick<TabsState, 'active'>;
  chats: Pick<ChatsState, 'get' | 'summaryOf'>;
  sessions: Pick<SessionsState, 'items'>;
  agents: Pick<AgentsState, 'items'>;
};

export class YourTurnState {
  /** The window is focused and visible. */
  focused = $state(false);

  private api: Api | null = null;
  private deps: YourTurnDeps | null = null;
  /** Finished turns announced to this window and not marked seen yet. */
  private readonly finished = new SvelteSet<string>();
  /**
   * Marked seen from this window since the chat's last announced finish: older
   * summaries that still say unread (the open chat's own, until it is reopened)
   * must not mark it again.
   */
  private readonly marked = new SvelteSet<string>();
  private readonly inflight = new Set<string>();
  /**
   * Chats whose markSeen failed while on screen: retried on their next view
   * (another tab first, or the window losing focus), not in a loop.
   */
  private readonly failed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The chat the pending timer marks. */
  private scheduled: string | null = null;
  private offs: (() => void)[] = [];

  init = (api: Api, deps: YourTurnDeps, opts: { debounceMs?: number; win?: Window } = {}): void => {
    this.stop();
    this.api = api;
    this.deps = deps;
    const debounceMs = opts.debounceMs ?? SEEN_DEBOUNCE_MS;
    const win = opts.win ?? window;
    const doc = win.document;

    this.focused = doc.visibilityState !== 'hidden' && doc.hasFocus();
    const onFocus = (): void => {
      this.focused = true;
    };
    const onBlur = (): void => {
      this.focused = false;
    };
    const onVisibility = (): void => {
      if (doc.visibilityState === 'hidden') onBlur();
    };
    win.addEventListener('focus', onFocus);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);

    const stopEffects = $effect.root(() => {
      $effect(() => {
        const id = deps.tabs.active;
        const focused = this.focused;
        const due = id !== null && focused && this.unread(id);
        untrack(() => {
          // A chat no longer on screen gets a fresh chance at its next view.
          for (const f of [...this.failed]) if (f !== id || !focused) this.failed.delete(f);
          if (due && this.scheduled === id) return; // a list refresh, not a new chance
          this.cancel();
          if (!due || this.failed.has(id)) return;
          this.scheduled = id;
          this.timer = setTimeout(() => {
            this.scheduled = null;
            if (this.visible(id) && this.unread(id)) this.markSeen(id);
          }, debounceMs);
        });
      });
    });

    this.offs = [
      () => {
        win.removeEventListener('focus', onFocus);
        win.removeEventListener('blur', onBlur);
        doc.removeEventListener('visibilitychange', onVisibility);
      },
      stopEffects,
      api.on('chatFinished', (e) => this.announced(e.sessionId)),
      api.on('chatBackFromHold', (e) => this.announced(e.sessionId)),
      // Turns may have ended while disconnected: the summaries fetched now decide.
      api.onOpen(() => {
        this.marked.clear();
        this.failed.clear();
      }),
    ];
  };

  stop = (): void => {
    this.cancel();
    for (const off of this.offs.splice(0)) off();
  };

  /** The chat is the active tab of a focused window. */
  visible = (sessionId: string): boolean => this.focused && this.deps?.tabs.active === sessionId;

  /**
   * Whether anything this window knows says the chat has something unseen: a
   * finished turn, or (v1.2) a hold that ran out (reactive).
   */
  unread = (sessionId: string): boolean => {
    if (this.finished.has(sessionId)) return true;
    const d = this.deps;
    if (!d || this.marked.has(sessionId)) return false;
    type Flags = { unread?: boolean; backFromHold?: boolean } | null | undefined;
    const unseen = (s: Flags): boolean => s?.unread === true || s?.backFromHold === true;
    const listed = (items: readonly { sessionId: string; unread?: boolean }[]) =>
      unseen(items.find((s) => s.sessionId === sessionId));
    return (
      unseen(d.chats.get(sessionId)?.summary) ||
      unseen(d.chats.summaryOf(sessionId)) ||
      listed(d.sessions.items) ||
      listed(d.agents.items)
    );
  };

  /** A finished turn or an ended hold was announced: seen at once if on screen. */
  private announced = (sessionId: string): void => {
    this.marked.delete(sessionId);
    this.failed.delete(sessionId);
    if (this.visible(sessionId)) this.markSeen(sessionId);
    else this.finished.add(sessionId);
  };

  private cancel = (): void => {
    clearTimeout(this.timer);
    this.scheduled = null;
  };

  /**
   * A failed request is not retried at once. After a lost connection the next
   * hello clears `marked` and the refreshed summaries decide again; after a
   * service error the chat is unread again and is retried on its next view.
   */
  private markSeen = (sessionId: string): void => {
    const api = this.api;
    if (!api || this.inflight.has(sessionId)) return;
    this.inflight.add(sessionId);
    this.finished.delete(sessionId);
    this.marked.add(sessionId);
    quietly(
      api
        .request('chat.markSeen', { sessionId })
        .then(
          () => {},
          (err: unknown) => {
            this.failed.add(sessionId);
            this.marked.delete(sessionId);
            throw err;
          },
        )
        .finally(() => this.inflight.delete(sessionId)),
    );
  };
}

export const yourTurn = new YourTurnState();

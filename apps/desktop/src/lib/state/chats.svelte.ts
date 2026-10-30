import type {
  ChatHeaderInfo,
  ChatItem,
  ChatItemsEvent,
  ChatStatus,
  ChatStatusEvent,
  ChatSummary,
} from '@pahub/protocol';
import { SvelteMap } from 'svelte/reactivity';
import { RequestError } from '../service/client';
import { quietly, type Api } from './api';

export const OPEN_TAIL = 200;
export const OLDER_PAGE = 200;

type ChatEvent = ChatItemsEvent | ChatStatusEvent;
type Schedule = (cb: () => void) => void;

/** Upserts `incoming` into `items` by id: known ids are replaced in place, new ids are appended. */
export const upsertItems = (items: ChatItem[], incoming: ChatItem[]): ChatItem[] => {
  const next = items.slice();
  const index = new Map<string, number>();
  next.forEach((it, i) => index.set(it.id, i));
  for (const it of incoming) {
    const at = index.get(it.id);
    if (at === undefined) {
      index.set(it.id, next.length);
      next.push(it);
    } else {
      next[at] = it;
    }
  }
  return next;
};

/** One open chat. Items use `$state.raw`: the array is replaced once per frame, never mutated. */
export class ChatState {
  items = $state.raw<ChatItem[]>([]);
  summary = $state.raw<ChatSummary | null>(null);
  header = $state.raw<ChatHeaderInfo>({});
  status = $state<ChatStatus>('unknown');
  waitingFor = $state<string | undefined>(undefined);
  seq = $state(0);
  hasMore = $state(false);
  loaded = $state(false);
  loadingOlder = $state(false);
  error = $state<string | null>(null);

  /** Permission requests the user still has to answer. */
  pendingRequests = $derived(
    this.items.filter((i) => i.kind === 'permissionRequest' && i.state === 'pending'),
  );

  /** Events that arrived while `chat.open` was in flight. */
  buffered: ChatEvent[] = [];
  /** `chat.items` events received but not yet applied (applied once per frame). */
  queued: ChatItemsEvent[] = [];

  constructor(readonly sessionId: string) {}
}

const defaultSchedule: Schedule = (cb) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

export class ChatsState {
  readonly byId = new SvelteMap<string, ChatState>();

  private api: Api | null = null;
  private schedule: Schedule = defaultSchedule;
  private flushScheduled = false;

  init = (api: Api, opts: { schedule?: Schedule } = {}): void => {
    this.api = api;
    if (opts.schedule) this.schedule = opts.schedule;
    api.on('chat.items', (e) => this.onItems(e));
    api.on('chat.status', (e) => this.onStatus(e));
    api.onReconnect(() => this.resync());
  };

  get = (sessionId: string): ChatState | undefined => this.byId.get(sessionId);

  /** Makes exactly these chats resident: opens missing ones, drops the rest (closed tabs keep no items). */
  sync = (sessionIds: readonly string[]): void => {
    const wanted = new Set(sessionIds);
    for (const id of [...this.byId.keys()]) if (!wanted.has(id)) this.drop(id);
    for (const id of wanted) if (!this.byId.has(id)) quietly(this.open(id));
  };

  drop = (sessionId: string): void => {
    this.byId.delete(sessionId);
  };

  /** Loads the tail of a chat; events arriving meanwhile are buffered and merged by seq. */
  open = async (sessionId: string): Promise<void> => {
    const api = this.api;
    if (!api) return;
    let chat = this.byId.get(sessionId);
    if (!chat) {
      chat = new ChatState(sessionId);
      this.byId.set(sessionId, chat);
    }
    chat.error = null;
    try {
      const r = await api.request('chat.open', { sessionId, tail: OPEN_TAIL });
      if (this.byId.get(sessionId) !== chat) return; // dropped meanwhile
      chat.items = r.items;
      chat.summary = r.summary;
      chat.header = r.header;
      chat.status = r.summary.status;
      chat.waitingFor = r.summary.waitingFor;
      chat.hasMore = r.hasMore;
      chat.seq = r.seq;
      chat.loaded = true;
      // Queued items at or below the snapshot are already part of it; applying a stale
      // version after a newer one would revert it.
      chat.queued = chat.queued.filter((e) => e.seq > r.seq);
      const buffered = chat.buffered.sort((a, b) => a.seq - b.seq);
      chat.buffered = [];
      for (const e of buffered) this.dispatch(chat, e);
    } catch (err) {
      if (this.byId.get(sessionId) === chat) {
        chat.error = err instanceof Error ? err.message : String(err);
      }
    }
  };

  loadOlder = async (sessionId: string): Promise<void> => {
    const chat = this.byId.get(sessionId);
    const first = chat?.items[0];
    if (!this.api || !chat || !first || !chat.hasMore || chat.loadingOlder) return;
    chat.loadingOlder = true;
    try {
      const r = await this.api.request('chat.older', {
        sessionId,
        beforeItemId: first.id,
        limit: OLDER_PAGE,
      });
      const known = new Set(chat.items.map((i) => i.id));
      chat.items = [...r.items.filter((i) => !known.has(i.id)), ...chat.items];
      chat.hasMore = r.hasMore;
    } catch (err) {
      chat.error = err instanceof Error ? err.message : String(err);
    } finally {
      chat.loadingOlder = false;
    }
  };

  /** After a reconnect: catch every resident chat up from its last seq; `GAP` falls back to a fresh open. */
  resync = async (): Promise<void> => {
    const api = this.api;
    if (!api) return;
    await Promise.all(
      [...this.byId.values()].map(async (chat) => {
        if (!chat.loaded) return this.open(chat.sessionId);
        try {
          const r = await api.request('chat.since', { sessionId: chat.sessionId, seq: chat.seq });
          if (this.byId.get(chat.sessionId) !== chat) return;
          for (const e of [...r.events].sort((a, b) => a.seq - b.seq)) this.dispatch(chat, e);
          this.flush();
          chat.seq = Math.max(chat.seq, r.seq);
        } catch (err) {
          if (err instanceof RequestError && err.code === 'DISCONNECTED') return;
          // GAP (or anything unexpected): the log cannot help, start over from the tail.
          chat.loaded = false;
          await this.open(chat.sessionId);
        }
      }),
    );
  };

  private onItems = (e: ChatItemsEvent): void => {
    const chat = this.byId.get(e.sessionId);
    if (chat) this.dispatch(chat, e);
  };

  private onStatus = (e: ChatStatusEvent): void => {
    const chat = this.byId.get(e.sessionId);
    if (chat) this.dispatch(chat, e);
  };

  /** Routes one event; events at or below the chat's seq are duplicates and ignored. */
  private dispatch = (chat: ChatState, e: ChatEvent): void => {
    if (!chat.loaded) {
      chat.buffered.push(e);
      return;
    }
    if (e.seq <= chat.seq) return;
    chat.seq = e.seq;
    if ('items' in e) {
      chat.queued.push(e);
      this.scheduleFlush();
    } else {
      chat.status = e.status;
      chat.waitingFor = e.waitingFor;
      if (e.header) chat.header = { ...chat.header, ...e.header };
    }
  };

  private scheduleFlush = (): void => {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  };

  /** Applies everything queued, one array replacement per chat. */
  flush = (): void => {
    this.flushScheduled = false;
    for (const chat of this.byId.values()) {
      if (chat.queued.length === 0) continue;
      const incoming = chat.queued.flatMap((e) => e.items);
      chat.queued = [];
      chat.items = upsertItems(chat.items, incoming);
    }
  };
}

export const chats = new ChatsState();

import type {
  ChatHeaderInfo,
  ImageRef,
  Params,
  ChatItem,
  ChatItemsEvent,
  ChatStatus,
  ChatStatusEvent,
  ChatSummary,
  Result,
} from '@pahub/protocol';
import { SvelteMap } from 'svelte/reactivity';
import { RequestError } from '../service/client';
import { quietly, type Api } from './api';

export const OPEN_TAIL = 200;
export const OLDER_PAGE = 200;

type ChatEvent = ChatItemsEvent | ChatStatusEvent;
export type ModelInfo = Result<'chat.models'>[number];
export type ResumeCheck = Result<'chat.resumeCheck'>;
export type RespondParams = Omit<Params<'chat.respond'>, 'sessionId'>;
/** How the user answered a request in this window (the item's state cannot say "always"). */
export type Decision = {
  decision: RespondParams['decision'];
  /** The answers given to an AskUserQuestion form. */
  answers?: Record<string, string>;
};

/** Statuses with a Claude process behind them: header controls apply live. */
export const LIVE_STATUSES: readonly ChatStatus[] = ['needsYou', 'working', 'idle'];

/**
 * What the message list remembers about a chat across tab switches (plain data,
 * not reactive): measured row heights and where the user was scrolled.
 */
export type ListMemory = {
  heights: Map<string, number>;
  stick: boolean;
  anchor: { key: string; delta: number } | null;
};
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
  /** True while `chat.since` is in flight: live events are buffered until it is merged. */
  resyncing = false;
  loadingOlder = $state(false);
  error = $state<string | null>(null);
  /** `chat.models` for this chat; null until loaded. */
  models = $state.raw<ModelInfo[] | null>(null);
  /** Message list geometry, kept while the chat is resident. */
  view: ListMemory = { heights: new Map(), stick: true, anchor: null };

  /** True while a Claude process runs this chat (header pickers apply live). */
  get live(): boolean {
    return LIVE_STATUSES.includes(this.status);
  }

  /**
   * True while pahub's own process runs this chat: messages go straight to it.
   * Otherwise (history, paused, failed, external) sending resumes the session
   * and needs the resume-safety check first (spec §4.4).
   */
  get ownedLive(): boolean {
    return this.live && !this.summary?.external;
  }

  /** Answers given here, by request id (shows "Always allowed" / the chosen answers). */
  readonly decisions = new SvelteMap<string, Decision>();
  /** Messages sent while Claude was working that the service queued (spec §6.4). */
  queuedMessages = $state(0);

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
  /**
   * Summaries of open tabs whose chat is not loaded yet (restored tabs in the
   * background): enough for the tab's title and status, kept current by
   * `chat.status` events. A chat is loaded only when its tab is first shown.
   */
  private readonly peeks = new SvelteMap<string, ChatSummary>();
  private readonly peeking = new Set<string>();

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

  /**
   * Follows the open tabs: the active chat is opened (and stays resident while
   * its tab is open, so switching back is instant); background tabs that were
   * never shown are not read at all, only summarised; closed tabs are dropped.
   * Restoring ten big chats at launch must not mean ten full transcript reads.
   */
  sync = (sessionIds: readonly string[], active: string | null): void => {
    const wanted = new Set(sessionIds);
    for (const id of [...this.byId.keys()]) if (!wanted.has(id)) this.drop(id);
    for (const id of [...this.peeks.keys()]) if (!wanted.has(id)) this.peeks.delete(id);
    if (active !== null && wanted.has(active) && !this.byId.has(active)) {
      quietly(this.open(active));
    }
    const unseen = [...wanted].filter(
      (id) => !this.byId.has(id) && !this.peeks.has(id) && !this.peeking.has(id),
    );
    if (unseen.length > 0) quietly(this.peek(unseen));
  };

  /** The tab-bar summary of an open chat that is not loaded (yet). */
  summaryOf = (sessionId: string): ChatSummary | undefined => this.peeks.get(sessionId);

  drop = (sessionId: string): void => {
    this.byId.delete(sessionId);
    this.peeks.delete(sessionId);
  };

  private peek = async (sessionIds: string[]): Promise<void> => {
    const api = this.api;
    if (!api) return;
    for (const id of sessionIds) this.peeking.add(id);
    try {
      const { items } = await api.request('sessions.summaries', { sessionIds });
      for (const s of items) {
        // Loaded or closed meanwhile: the chat itself (or nothing) is the source now.
        if (this.peeking.has(s.sessionId) && !this.byId.has(s.sessionId)) {
          this.peeks.set(s.sessionId, s);
        }
      }
    } finally {
      for (const id of sessionIds) this.peeking.delete(id);
    }
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

  /** Loads the models a chat can switch to (once per chat; retried after a failure). */
  loadModels = async (sessionId: string): Promise<void> => {
    const chat = this.byId.get(sessionId);
    if (!this.api || !chat) return;
    const models = await this.api.request('chat.models', { sessionId });
    if (this.byId.get(sessionId) === chat) chat.models = models;
  };

  /** Changes a header setting of a live chat; the header shows the new value once applied. */
  private setHeader = async (
    method: 'chat.setModel' | 'chat.setEffort' | 'chat.setPermissionMode',
    field: 'model' | 'effort' | 'permissionMode',
    sessionId: string,
    value: string,
  ): Promise<void> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    await this.api.request(method, { sessionId, value });
    const chat = this.byId.get(sessionId);
    if (chat) chat.header = { ...chat.header, [field]: value };
  };

  setModel = (sessionId: string, value: string): Promise<void> =>
    this.setHeader('chat.setModel', 'model', sessionId, value);

  setEffort = (sessionId: string, value: string): Promise<void> =>
    this.setHeader('chat.setEffort', 'effort', sessionId, value);

  setPermissionMode = (sessionId: string, value: string): Promise<void> =>
    this.setHeader('chat.setPermissionMode', 'permissionMode', sessionId, value);

  /** Sends a message; resolves to whether the service queued it behind the running turn. */
  send = async (sessionId: string, text: string, images?: ImageRef[]): Promise<boolean> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    const r = await this.api.request('chat.send', {
      sessionId,
      text,
      ...(images?.length ? { images } : {}),
    });
    const chat = this.byId.get(sessionId);
    if (r.queued && chat) chat.queuedMessages += 1;
    return r.queued;
  };

  /** Starts a chat in `cwd` with its first message; resolves to the new chat's id. */
  create = async (p: Params<'chat.create'>): Promise<string> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    if (p.permissionMode === 'bypassPermissions') {
      throw new Error('pahub does not offer the bypassPermissions mode'); // Ruling R11
    }
    const params = { ...p };
    if (!params.images?.length) delete params.images;
    return (await this.api.request('chat.create', params)).sessionId;
  };

  /** Stops the current turn (Stop button / Esc). */
  interrupt = async (sessionId: string): Promise<void> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    await this.api.request('chat.interrupt', { sessionId });
  };

  /** Answers a permission request, question or plan approval. */
  respond = async (
    sessionId: string,
    p: RespondParams,
    answers?: Record<string, string>,
  ): Promise<void> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    await this.api.request('chat.respond', { sessionId, ...p });
    this.byId
      .get(sessionId)
      ?.decisions.set(p.requestId, { decision: p.decision, ...(answers ? { answers } : {}) });
  };

  /** Whether this chat may be resumed here (spec §4.4). */
  resumeCheck = async (sessionId: string): Promise<ResumeCheck> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    return this.api.request('chat.resumeCheck', { sessionId });
  };

  /** Ends the chat's Claude process (the chat stays open as history). */
  end = async (sessionId: string): Promise<void> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    await this.api.request('chat.end', { sessionId });
  };

  /** Forks the chat up to (and including) a user message; resolves to the new chat's id. */
  fork = async (sessionId: string, upToItemId: string): Promise<string> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    const r = await this.api.request('chat.fork', { sessionId, upToItemId });
    return r.sessionId;
  };

  /** The terminal command that continues this chat (`claude --resume <id>` or `claude attach`). */
  resumeCommand = async (sessionId: string): Promise<string> => {
    if (!this.api) throw new Error('Not connected to the pahub service');
    return (await this.api.request('chat.resumeCommand', { sessionId })).command;
  };

  /** After a reconnect: catch every resident chat up from its last seq; `GAP` falls back to a fresh open. */
  resync = async (): Promise<void> => {
    const api = this.api;
    if (!api) return;
    await Promise.all(
      [...this.byId.values()].map(async (chat) => {
        if (!chat.loaded) return this.open(chat.sessionId);
        chat.resyncing = true;
        try {
          const r = await api.request('chat.since', { sessionId: chat.sessionId, seq: chat.seq });
          if (this.byId.get(chat.sessionId) !== chat) return;
          for (const e of [...r.events].sort((a, b) => a.seq - b.seq)) this.apply(chat, e);
          chat.seq = Math.max(chat.seq, r.seq);
          // Live events that arrived meanwhile follow the merged history.
          chat.resyncing = false;
          const buffered = chat.buffered.sort((a, b) => a.seq - b.seq);
          chat.buffered = [];
          for (const e of buffered) this.dispatch(chat, e);
          this.flush();
        } catch (err) {
          chat.resyncing = false;
          if (err instanceof RequestError && err.code === 'DISCONNECTED') {
            // The next reconnect resyncs from chat.seq; buffered events would leave a hole.
            chat.buffered = [];
            return;
          }
          // GAP (or anything unexpected): the log cannot help, start over from the tail
          // (open() merges the buffered live events above its snapshot).
          chat.loaded = false;
          await this.open(chat.sessionId);
        } finally {
          chat.resyncing = false;
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
    if (chat) {
      this.dispatch(chat, e);
      return;
    }
    const peek = this.peeks.get(e.sessionId);
    if (peek) {
      const next: ChatSummary = { ...peek, status: e.status };
      if (e.waitingFor === undefined) delete next.waitingFor;
      else next.waitingFor = e.waitingFor;
      this.peeks.set(e.sessionId, next);
    }
  };

  /** Routes one event; events at or below the chat's seq are duplicates and ignored. */
  private dispatch = (chat: ChatState, e: ChatEvent): void => {
    if (!chat.loaded || chat.resyncing) {
      chat.buffered.push(e);
      return;
    }
    this.apply(chat, e);
  };

  private apply = (chat: ChatState, e: ChatEvent): void => {
    if (e.seq <= chat.seq) return;
    chat.seq = e.seq;
    if ('items' in e) {
      chat.queued.push(e);
      this.scheduleFlush();
    } else {
      chat.status = e.status;
      chat.waitingFor = e.waitingFor;
      // The turn ended: whatever was queued has been taken up.
      if (e.status !== 'working' && e.status !== 'needsYou') chat.queuedMessages = 0;
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

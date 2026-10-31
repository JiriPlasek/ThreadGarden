/**
 * Router handlers for one chat (§4.3–§4.5, §6.4): open / page / replay,
 * create / send / resume, controls, permission answers, fork, stopping a
 * task (v1.1 §2), the command and model lists, the seen state behind
 * "Your turn" (v1.1 `chat.markSeen`) and "Back from hold" (v1.2), and the
 * names of the chats pahub starts (v1.2 C1, `chat/titles.ts`).
 *
 * Validation that the protocol schema leaves open happens here: permission
 * modes are limited to what pahub offers (Ruling R11: never
 * `bypassPermissions`), effort to the SDK's levels, models to non-empty names.
 *
 * Errors the UI acts on carry a code: `NOT_FOUND`, `NOT_LIVE`, `GAP` (the
 * client's seq is not replayable → `chat.open` again), `CLAUDE_MISSING`,
 * `RESUME_BLOCKED` (§4.4, with the reason to show), `FORK_FAILED`,
 * `UNKNOWN_TASK`, `STOP_FAILED`, `INVALID_PARAMS`.
 */
import type { ChatHeaderInfo, ChatItem, ChatTask, EventMsg, ImageRef } from '@pahub/protocol';
import type { LiveSession, UserInput } from '../../chat/live-session.js';
import { Normalizer } from '../../chat/normalize.js';
import type { SessionHost } from '../../chat/session-host.js';
import type { ChatTitles } from '../../chat/titles.js';
import type { ResumeCheck } from '../../external/resume-safety.js';
import type { Catalog } from '../../history/catalog.js';
import type { Db } from '../../history/db.js';
import type {
  AgentAdapter,
  Effort,
  ModelInfo,
  PermissionMode,
  SlashCommand,
} from '../../sdk/adapter.js';
import type { ClaudeFound, ClaudeProblem } from '../../sdk/claude-path.js';
import { ServiceError, type Router } from '../router.js';

/** Permission modes pahub offers (Ruling R11). */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
];
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Approximate budget (characters of item text) of the normalized-history
 * cache; least recently used chats are dropped beyond it (the most recent
 * one is always kept).
 */
export const HISTORY_CACHE_CHARS = 32 * 1024 * 1024;

export type ChatHandlerDeps = {
  host: SessionHost;
  adapter: AgentAdapter;
  db: Db;
  catalog: Catalog;
  claude: () => ClaudeFound | ClaudeProblem | undefined;
  /** Settles once a search for `claude` in progress has finished. */
  located?: () => Promise<void>;
  /**
   * True when this build runs chats only on an API key (spec §5.5) and none
   * is set: starting or resuming a chat is refused.
   */
  apiKeyMissing?: () => boolean;
  resumeCheck: (sessionId: string) => Promise<ResumeCheck>;
  /** Indexes sessions that pahub just caused to exist (a fork), so they can be opened at once. */
  indexNow: (sessionIds: string[]) => Promise<void>;
  emit: (e: EventMsg) => void;
  onError: (err: unknown, context: string) => void;
  /** Overrides `HISTORY_CACHE_CHARS`. */
  historyCacheChars?: number;
  /** Clock for the seen time of `chat.markSeen` (v1.1); default `Date.now`. */
  now?: () => number;
  // ── v1.2 C1: chat titles ──
  /** Names the chats pahub starts (provisional title, then a generated one). */
  titles?: ChatTitles;
};

/** Rough memory weight of an item: its text plus a fixed overhead. */
const itemChars = (i: ChatItem): number => {
  switch (i.kind) {
    case 'user':
    case 'thinking':
      return 100 + i.text.length;
    case 'system':
      return 100 + i.text.length + (i.detail?.length ?? 0);
    case 'assistantText':
      return 100 + i.markdown.length;
    case 'toolCall':
      return 300 + (i.resultText?.length ?? 0);
    default:
      return 300;
  }
};

type CacheEntry = {
  /** The host's session object when read while pahub held the chat, else undefined. */
  owner: LiveSession | undefined;
  /** For history-only chats: the indexed `lastModified:fileSize` at read time. */
  key: string | undefined;
  items: ChatItem[];
  chars: number;
};

type Command = { name: string; description: string; argumentHint: string };
type Model = {
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: string[];
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const permissionMode = (v: string | undefined): PermissionMode | undefined => {
  if (v === undefined) return undefined;
  if (!(PERMISSION_MODES as readonly string[]).includes(v)) {
    throw new ServiceError(
      'INVALID_PARAMS',
      `Unsupported permission mode "${v}" (pahub offers ${PERMISSION_MODES.join(', ')})`,
    );
  }
  return v as PermissionMode;
};

const effort = (v: string | undefined): Effort | undefined => {
  if (v === undefined) return undefined;
  if (!(EFFORT_LEVELS as readonly string[]).includes(v)) {
    throw new ServiceError(
      'INVALID_PARAMS',
      `Unsupported effort "${v}" (one of ${EFFORT_LEVELS.join(', ')})`,
    );
  }
  return v as Effort;
};

const model = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  if (v.trim() === '') throw new ServiceError('INVALID_PARAMS', 'Model must not be empty');
  return v;
};

const toInput = (p: { text: string; images?: ImageRef[] | undefined }): UserInput => ({
  text: p.text,
  ...(p.images?.length
    ? { images: p.images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.data })) }
    : {}),
});

const toCommand = (c: SlashCommand): Command => ({
  name: c.name,
  description: c.description,
  argumentHint: c.argumentHint,
});

const toModel = (m: ModelInfo): Model => ({
  value: m.value,
  displayName: m.displayName,
  description: m.description,
  ...(m.supportedEffortLevels ? { supportedEffortLevels: [...m.supportedEffortLevels] } : {}),
});

export const registerChatHandlers = (router: Router, deps: ChatHandlerDeps): void => {
  const { host, adapter, db, catalog } = deps;
  const historyCache = new Map<string, CacheEntry>();
  const cacheBudget = deps.historyCacheChars ?? HISTORY_CACHE_CHARS;
  let cachedChars = 0;
  const forget = (sessionId: string): void => {
    const e = historyCache.get(sessionId);
    if (!e) return;
    cachedChars -= e.chars;
    historyCache.delete(sessionId);
  };
  const commandsByCwd = new Map<string, Command[]>();
  let lastCommands: Command[] | undefined;
  let lastModels: Model[] | undefined;

  const changed = (sessionIds: string[]) =>
    deps.emit({ event: 'sessions.changed', data: { sessionIds } });

  /**
   * v1.1 "Your turn": the user has seen the chat's latest turn, and (v1.2)
   * that it came back from hold. Lists change (Needs you, counts) only when
   * that cleared something.
   */
  const markSeen = (sessionId: string): void => {
    const seen = db.markSeen(sessionId, (deps.now ?? Date.now)());
    const back = db.clearBackFromHold(sessionId);
    if (seen || back) changed([sessionId]);
  };
  /** v1.2 auto-unarchive: an archived chat that is sent a message returns to Active. */
  const unarchive = (sessionId: string): void => {
    if (db.unarchive([sessionId]).length === 0) return;
    catalog.bucketChanged([sessionId], 'active');
    changed([sessionId]);
  };

  /**
   * v1.2 C1: names a chat pahub starts (`untitledOnly`: one it continues,
   * only while it has no title at all). True when its title changed. A
   * failure is reported and never fails the request.
   */
  const nameChat = (sessionId: string, cwd: string, text: string, untitledOnly: boolean) => {
    const titles = deps.titles;
    if (!titles) return false;
    try {
      return untitledOnly
        ? titles.startedIfUntitled(sessionId, cwd, text)
        : titles.started(sessionId, cwd, text);
    } catch (err) {
      deps.onError(err, `title of ${sessionId}`);
      return false;
    }
  };

  /** A Claude Code process may be started: `claude` is found and the auth policy is met. */
  const requireRunnable = async (): Promise<void> => {
    if (deps.apiKeyMissing?.()) {
      throw new ServiceError(
        'API_KEY_REQUIRED',
        'This build of pahub runs chats only on an Anthropic API key. Add your key in Settings to start or continue a chat.',
      );
    }
    await deps.located?.();
    const c = deps.claude();
    if (c && 'path' in c) return;
    throw new ServiceError('CLAUDE_MISSING', c?.detail ?? 'Claude Code has not been located yet.');
  };

  const requireLive = (sessionId: string): LiveSession => {
    const s = host.get(sessionId);
    if (!s?.live) throw new ServiceError('NOT_LIVE', `Chat ${sessionId} is not running`);
    return s;
  };

  /**
   * The chat's SDK history as items (upserted by id, so tool results update
   * their calls), read and normalized at most once per validity window:
   * - while the host holds the chat (live, paused or failed), for the life of
   *   that session object. Resume safety (§4.4) means nothing but this process
   *   writes the transcript meanwhile, and everything the process produced
   *   after the read is in its snapshot. End, stop-all and resume replace or
   *   drop the object, so the next open reads again;
   * - for a history-only chat, while its indexed `lastModified`/`fileSize`
   *   stay the same.
   */
  const historyItems = async (sessionId: string): Promise<ChatItem[]> => {
    const owner = host.get(sessionId);
    const row = owner ? undefined : db.getSession(sessionId);
    const key = row ? `${row.lastModified}:${row.fileSize}` : undefined;
    const hit = historyCache.get(sessionId);
    const valid = owner
      ? hit?.owner === owner
      : hit?.owner === undefined && key !== undefined && hit?.key === key;
    if (hit && valid) {
      historyCache.delete(sessionId); // most recently used last
      historyCache.set(sessionId, hit);
      return hit.items;
    }
    const messages = await adapter.getSessionMessages(sessionId);
    const normalizer = new Normalizer();
    const byId = new Map<string, ChatItem>();
    for (const m of messages) for (const item of normalizer.push(m).items) byId.set(item.id, item);
    const items = [...byId.values()];
    forget(sessionId);
    // Only cache what has a validity window; and only if the chat was not
    // taken over or released while the read ran.
    if ((owner && host.get(sessionId) === owner) || (!owner && key !== undefined)) {
      const chars = items.reduce((n, i) => n + itemChars(i), 0);
      historyCache.set(sessionId, { owner, key, items, chars });
      cachedChars += chars;
      for (const old of historyCache.keys()) {
        if (cachedChars <= cacheBudget || old === sessionId) break;
        forget(old);
      }
    }
    return items;
  };

  /**
   * Everything the chat shows: SDK history, then the items of the session
   * the host holds (live, paused or failed). History entries the live
   * process already rendered — same id, or a streamed item's final message
   * (`resolveItemId`) — are dropped in favour of the live version. The live
   * snapshot is taken after the history read, so `seq` covers every item
   * (and the task list, which only a chat the host holds has).
   */
  const view = async (
    sessionId: string,
  ): Promise<{ items: ChatItem[]; seq: number; header: ChatHeaderInfo; tasks: ChatTask[] }> => {
    let history: ChatItem[];
    try {
      history = await historyItems(sessionId);
    } catch (err) {
      // A chat pahub runs may not have a transcript yet; a history-only chat needs one.
      if (!host.get(sessionId)) throw err;
      deps.onError(err, `history of ${sessionId}`);
      history = [];
    }
    const s = host.get(sessionId);
    if (!s) return { items: history, seq: host.seqOf(sessionId), header: {}, tasks: [] };
    const snap = s.snapshot(Number.MAX_SAFE_INTEGER);
    const own = new Set(snap.items.map((i) => i.id));
    const earlier = history.filter((i) => !own.has(i.id) && !own.has(s.resolveItemId(i.id) ?? ''));
    return {
      items: [...earlier, ...snap.items],
      seq: snap.seq,
      header: snap.header,
      tasks: snap.tasks,
    };
  };

  router.register('chat.open', async (p) => {
    if (!catalog.summary(p.sessionId)) {
      throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    }
    const v = await view(p.sessionId);
    // Read after the view so a status change during the history read is reflected.
    const summary = catalog.summary(p.sessionId)!;
    const n = Math.max(0, Math.floor(p.tail));
    const items = n === 0 ? [] : v.items.slice(-n);
    return {
      summary,
      header: v.header,
      items,
      hasMore: v.items.length > items.length,
      seq: v.seq,
      tasks: v.tasks,
    };
  });

  router.register('chat.older', async (p) => {
    const { items } = await view(p.sessionId);
    const end = items.findIndex((i) => i.id === p.beforeItemId);
    if (end < 0) throw new ServiceError('NOT_FOUND', `No item ${p.beforeItemId} in this chat`);
    const start = Math.max(0, end - Math.max(1, Math.floor(p.limit)));
    return { items: items.slice(start, end), hasMore: start > 0 };
  });

  router.register('chat.since', async (p) => {
    const events = host.since(p.sessionId, p.seq);
    if (events === 'gap') {
      throw new ServiceError(
        'GAP',
        `Events after ${p.seq} are not available; reload the chat with chat.open`,
      );
    }
    return { events: events.map((e) => e.data), seq: host.seqOf(p.sessionId) };
  });

  router.register('chat.create', async (p) => {
    const choices = {
      ...(p.model === undefined ? {} : { model: model(p.model) }),
      ...(p.permissionMode === undefined
        ? {}
        : { permissionMode: permissionMode(p.permissionMode) }),
      ...(p.effort === undefined ? {} : { effort: effort(p.effort) }),
    };
    await requireRunnable();
    const s = host.create(p.cwd, toInput(p), choices);
    nameChat(s.sessionId, p.cwd, p.text, false); // shown with the change below
    markSeen(s.sessionId); // a new chat has nothing unseen; kept for symmetry with chat.send
    changed([s.sessionId]);
    return { sessionId: s.sessionId };
  });

  router.register('chat.send', async (p) => {
    const input = toInput(p);
    let s = host.get(p.sessionId);
    if (!s?.live) {
      await requireRunnable();
      const cwd =
        s?.cwd ??
        db.getSession(p.sessionId)?.cwd ??
        (await adapter.getSessionInfo(p.sessionId))?.cwd;
      if (!cwd) throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
      // §4.4: never continue a session another process is running. `unverified`
      // is allowed; the UI asked the user to confirm before sending.
      const check = await deps.resumeCheck(p.sessionId);
      if (check.status === 'blocked') throw new ServiceError('RESUME_BLOCKED', check.reason);
      forget(p.sessionId); // the resumed process's view starts from a fresh read
      s = host.ensureLive(p.sessionId, cwd);
      changed([p.sessionId]);
    }
    const sent = s.send(input);
    markSeen(p.sessionId); // replying means the last turn was seen
    unarchive(p.sessionId); // nothing gets lost in the archive
    if (nameChat(p.sessionId, s.cwd, p.text, true)) changed([p.sessionId]);
    return sent;
  });

  router.register('chat.markSeen', async (p) => {
    markSeen(p.sessionId);
    return {};
  });

  router.register('chat.interrupt', async (p) => {
    const s = host.get(p.sessionId);
    if (s?.live) await s.interrupt();
    return {};
  });

  router.register('chat.end', async (p) => {
    if (host.get(p.sessionId)) {
      forget(p.sessionId); // the transcript now holds the live turns
      deps.titles?.forget(p.sessionId); // a first turn cut short gets no generated title
      host.end(p.sessionId);
      changed([p.sessionId]);
    }
    return {};
  });

  router.register('chat.setModel', async (p) => {
    const value = model(p.value)!;
    await requireLive(p.sessionId).setModel(value);
    return {};
  });

  router.register('chat.setPermissionMode', async (p) => {
    const value = permissionMode(p.value)!;
    await requireLive(p.sessionId).setPermissionMode(value);
    return {};
  });

  router.register('chat.setEffort', async (p) => {
    const value = effort(p.value)!;
    await requireLive(p.sessionId).setEffort(value);
    return {};
  });

  /** Only a chat pahub runs has tasks it can stop (`NOT_LIVE` otherwise). */
  router.register('chat.stopTask', async (p) => {
    await requireLive(p.sessionId).stopTask(p.taskId);
    return {};
  });

  router.register('chat.respond', async (p) => {
    const s = host.get(p.sessionId);
    const pending = s
      ?.pendingRequests()
      .some((r) => r.kind === 'permissionRequest' && r.requestId === p.requestId);
    if (!s || !pending) {
      throw new ServiceError('NOT_FOUND', `No pending request ${p.requestId} in this chat`);
    }
    s.respond(p.requestId, {
      decision: p.decision,
      ...(p.reason === undefined ? {} : { reason: p.reason }),
      ...(p.suggestionIndex === undefined ? {} : { suggestionIndex: p.suggestionIndex }),
      ...(p.updatedInput === undefined ? {} : { updatedInput: p.updatedInput }),
    });
    return {};
  });

  router.register('chat.fork', async (p) => {
    const s = host.get(p.sessionId);
    const uuid = s ? s.messageUuidOf(p.upToItemId) : (p.upToItemId.split(':')[0] ?? '');
    if (!uuid) throw new ServiceError('INVALID_PARAMS', 'upToItemId must name a message');
    let forked: { sessionId: string };
    try {
      forked = await adapter.forkSession(p.sessionId, { upToMessageId: uuid });
    } catch (err) {
      throw new ServiceError('FORK_FAILED', `Could not fork this chat: ${errorText(err)}`);
    }
    await deps.indexNow([forked.sessionId]).catch((err: unknown) => {
      deps.onError(err, `index fork ${forked.sessionId}`);
    });
    return { sessionId: forked.sessionId };
  });

  /** The named chat if live, else any live chat in `cwd`. */
  const liveFor = (sessionId: string | undefined, cwd: string | undefined) => {
    const own = sessionId === undefined ? undefined : host.get(sessionId);
    if (own?.live) return own;
    if (cwd === undefined) return undefined;
    const other = host.list().find((c) => c.live && c.cwd === cwd);
    return other ? host.get(other.sessionId) : undefined;
  };

  /**
   * Slash commands come from a running process; the last answer per project
   * (and overall) is remembered for chats without one (new or history chats).
   */
  router.register('chat.commands', async (p) => {
    const cwd =
      p.cwd ??
      (p.sessionId === undefined
        ? undefined
        : (host.get(p.sessionId)?.cwd ?? db.getSession(p.sessionId)?.cwd ?? undefined));
    const s = liveFor(p.sessionId, cwd);
    if (s) {
      try {
        const list = (await s.supportedCommands()).map(toCommand);
        commandsByCwd.set(s.cwd, list);
        lastCommands = list;
        return list;
      } catch (err) {
        deps.onError(err, `supportedCommands (session ${s.sessionId})`);
      }
    }
    return (cwd === undefined ? undefined : commandsByCwd.get(cwd)) ?? lastCommands ?? [];
  });

  router.register('chat.models', async (p) => {
    const s =
      liveFor(p.sessionId, p.cwd) ?? liveFor(undefined, host.list().find((c) => c.live)?.cwd);
    if (s) {
      try {
        lastModels = (await s.supportedModels()).map(toModel);
      } catch (err) {
        deps.onError(err, `supportedModels (session ${s.sessionId})`);
      }
    }
    return lastModels ?? [];
  });
};

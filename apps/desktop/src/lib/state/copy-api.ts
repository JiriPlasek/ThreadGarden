/**
 * What a paired machine's scope asks while the machine is away (away machine
 * spec): its lists and its chats' last messages come from this device's copy,
 * which the local service keeps (`copies.*`), and a message written for it
 * waits in the local service's queue (`away.queue`) until the machine is up.
 * The machine itself is never asked, and reading never turns it on.
 */
import {
  AWAY_CAPABILITY,
  AWAY_ERROR,
  type ChatSummary,
  type MachineCopy,
  type MachineInfo,
  type MethodName,
  type Params,
  type Place,
  type Result,
} from '@threadgarden/protocol';
import { RequestError } from '../service/client';
import type { Api } from './api';
import { mergeOrder } from './merged-list.svelte';

/** A `chat.open` answered from the copy carries when the copy was made. */
type CopiedOpen = Result<'chat.open'> & { copiedAt?: number };

/** When the chat `chat.open` answered was copied; null for a live answer. */
export const copiedAtOf = (r: Result<'chat.open'>): number | null =>
  (r as CopiedOpen).copiedAt ?? null;

export type CopyApiOptions = {
  /** The machine's name, as the UI says it (`‹machine› is off`). */
  name: () => string;
  /** Told of each copy read (null: there is none), e.g. for "last seen". */
  seen?: (copy: MachineCopy | null) => void;
  /** What the machine's last hello said, for when its copy doesn't say. */
  hello?: () => MachineInfo | null;
};

/**
 * Ruling R10: a machine that is away runs nothing, whatever its chats were
 * doing when it was last seen. What waits on the user (Needs you, unread,
 * back from hold) still does.
 */
const resting = (c: ChatSummary): ChatSummary => {
  const stopped = c.status === 'working' || c.status === 'unknown';
  if (!stopped && (c.runningTasks ?? 0) === 0) return c;
  return { ...c, status: stopped ? 'idle' : c.status, runningTasks: 0 };
};

/** The bucket a bucket place lists (`all` is Active, v1.2). */
const bucketOf = (kind: string): string => (kind === 'all' ? 'active' : kind);

/** Waiting on the user, unread, or back from hold: what Needs you lists. */
const needsYou = (c: ChatSummary): boolean => c.status === 'needsYou' || c.unread || c.backFromHold;

/** Working, or a live chat with background tasks still running (Ruling R29). */
const running = (c: ChatSummary): boolean => c.status === 'working' || (c.runningTasks ?? 0) > 0;

/** The chats of `place` in the copy, as the machine's own service would list them. */
const inPlace = (copy: MachineCopy, place: Place): ChatSummary[] => {
  const hidden = new Set(copy.projects.filter((p) => p.hidden).map((p) => p.projectId));
  const keep = (c: ChatSummary): boolean => {
    if (place.kind === 'needsYou') return needsYou(c);
    if (place.kind === 'running') return running(c);
    if (place.kind === 'project') {
      const buckets = ['active', ...(place.include ?? [])];
      return c.projectId === place.projectId && buckets.includes(c.bucket);
    }
    return !hidden.has(c.projectId) && c.bucket === bucketOf(place.kind);
  };
  return copy.chats.filter(keep).sort(mergeOrder(place));
};

const matches = (c: ChatSummary, query: string | undefined): boolean => {
  const q = query?.trim().toLowerCase();
  return !q || c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q);
};

const counts = (copy: MachineCopy): Result<'places.counts'> => {
  const n = (kind: 'active' | 'onHold' | 'archived'): number => inPlace(copy, { kind }).length;
  const active = n('active');
  return {
    needsYou: inPlace(copy, { kind: 'needsYou' }).length,
    running: inPlace(copy, { kind: 'running' }).length,
    all: active,
    active,
    onHold: n('onHold'),
    archived: n('archived'),
  };
};

/** One page of the copy's list; the cursor is where the next page starts. */
const page = (copy: MachineCopy, p: Params<'sessions.list'>): Result<'sessions.list'> => {
  const all = inPlace(copy, p.place).filter((c) => matches(c, p.query));
  const start = p.cursor ? Number(p.cursor) || 0 : 0;
  const end = start + p.limit;
  return {
    items: all.slice(start, end),
    ...(end < all.length ? { nextCursor: String(end) } : {}),
  };
};

/** Only the keys that have a value, so the queue sees exactly what was written. */
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * The copy API of machine `machineId`, on the local service `local`. Lists and
 * chats come from the copy; `chat.send` and `chat.create` queue the message;
 * anything else is refused with `AWAY` ("‹machine› is off").
 */
export const copyApi = (
  machineId: string,
  local: Pick<Api, 'request'>,
  o: CopyApiOptions,
): Pick<Api, 'request'> => {
  const off = (): RequestError => new RequestError(AWAY_ERROR, `${o.name()} is off`);

  /** Calls made together (counts and projects) share one read. */
  let reading: Promise<MachineCopy | null> | null = null;
  const read = (): Promise<MachineCopy | null> =>
    (reading ??= local
      .request('copies.get', { machineId })
      .then((stored) => {
        const copy = stored && { ...stored, chats: stored.chats.map(resting) };
        o.seen?.(copy);
        return copy;
      })
      .finally(() => {
        reading = null;
      }));
  const copy = async (): Promise<MachineCopy> => {
    const c = await read();
    if (!c) throw off();
    return c;
  };

  const open = async (p: Params<'chat.open'>): Promise<CopiedOpen> => {
    const [lists, chat] = await Promise.all([
      read(),
      local.request('copies.chat', { machineId, sessionId: p.sessionId }),
    ]);
    // The lists are refreshed more often than a chat's tail: their summary is the newer.
    const summary = lists?.chats.find((c) => c.sessionId === p.sessionId) ?? chat?.summary;
    const copiedAt = chat?.copiedAt ?? lists?.copiedAt;
    if (!summary || copiedAt === undefined) throw off();
    return {
      summary: resting(summary),
      header: {},
      items: chat?.items ?? [],
      hasMore: false,
      seq: 0,
      tasks: [],
      movedTo: null,
      copiedAt,
    };
  };

  /**
   * Every message for the machine passes here (the composer, Send again, a
   * Move's note, a new chat): one that can't take a message exactly once
   * (no `away`, as its copy says, else its last hello) is never queued, as a
   * retry could reach it twice.
   */
  const mayQueue = async (): Promise<void> => {
    const info = (await read())?.info ?? o.hello?.() ?? null;
    if (info?.capabilities.includes(AWAY_CAPABILITY)) return;
    throw new RequestError(AWAY_ERROR, `Update ${o.name()} to send while it's off`);
  };

  const send = async (p: Params<'chat.send'>): Promise<Result<'chat.send'>> => {
    await mayQueue();
    await local.request(
      'away.queue',
      defined({
        machineId,
        sessionId: p.sessionId,
        kind: 'send' as const,
        text: p.text,
        images: p.images?.length ? p.images : undefined,
      }) as Params<'away.queue'>,
    );
    // The waiting line says what happens next; it is not queued behind a turn.
    return { queued: false };
  };

  const create = async (p: Params<'chat.create'>): Promise<Result<'chat.create'>> => {
    // The chat's id is chosen here, so the machine makes it under the same one.
    const sessionId = p.sessionId ?? crypto.randomUUID();
    await mayQueue();
    await local.request(
      'away.queue',
      defined({
        machineId,
        sessionId,
        kind: 'create' as const,
        text: p.text,
        images: p.images?.length ? p.images : undefined,
        cwd: p.cwd,
        model: p.model,
        permissionMode: p.permissionMode,
        effort: p.effort,
      }) as Params<'away.queue'>,
    );
    return { sessionId };
  };

  const answer = async (method: MethodName, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'places.counts':
        return counts(await copy());
      case 'projects.list':
        return (await copy()).projects;
      case 'sessions.list':
        return page(await copy(), params as Params<'sessions.list'>);
      case 'sessions.summaries': {
        const ids = new Set((params as Params<'sessions.summaries'>).sessionIds);
        return { items: (await copy()).chats.filter((c) => ids.has(c.sessionId)) };
      }
      case 'chat.open':
        return open(params as Params<'chat.open'>);
      case 'chat.older':
        return { items: [], hasMore: false };
      case 'chat.resumeCheck':
        // Whether it may be resumed is the machine's to say when the message arrives.
        return { status: 'ok', reason: '', recentlyModified: false };
      case 'chat.send':
        return send(params as Params<'chat.send'>);
      case 'chat.create':
        return create(params as Params<'chat.create'>);
      default:
        throw off();
    }
  };

  return {
    request: <M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> =>
      answer(method, params) as Promise<Result<M>>,
  };
};

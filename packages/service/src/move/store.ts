/**
 * Threadgarden's own Agent SDK `SessionStore`, in the service's db. A chat moved
 * here lives in it (the SDK's `resume` and `getSessionMessages` read it with
 * `{ sessionStore }`); nothing is written under `~/.claude`. The store answers
 * for any `projectKey`: a chat is found by `sessionId` and `subpath` alone,
 * since the SDK asks with the key of the target folder.
 */
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { MovePeer } from '@threadgarden/protocol';
import type { Db, StoreRow } from '../history/db.js';
import type { HistoryOptions } from '../sdk/adapter.js';

type Entry = SessionStoreEntry;
type KeyEntries = { subpath?: string; entries: Entry[] };

/** The db keeps the main transcript under '' (the SDK leaves `subpath` out). */
const toSubpath = (subpath: string | undefined): string => subpath ?? '';

const toRows = (entries: Entry[]): StoreRow[] =>
  entries.map((e) => ({
    uuid: typeof e.uuid === 'string' ? e.uuid : null,
    entry: JSON.stringify(e),
  }));

export class ChatStore {
  private sdk: SessionStore | undefined;

  constructor(
    private readonly db: Db,
    private readonly onAppend: (sessionId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The SDK adapter (always the same object): pass it as `sessionStore`. */
  sessionStore(): SessionStore {
    this.sdk ??= {
      append: (key: SessionKey, entries: Entry[]) => {
        this.db.storeAppend(key.sessionId, toSubpath(key.subpath), toRows(entries));
        // The listed `mtime` follows the chat's activity.
        this.db.touchMovedChat(key.sessionId, this.now());
        this.onAppend(key.sessionId);
        return Promise.resolve();
      },
      load: (key: SessionKey) => {
        const rows = this.db.storeLoad(key.sessionId, toSubpath(key.subpath));
        return Promise.resolve(rows.length === 0 ? null : rows.map((r) => JSON.parse(r) as Entry));
      },
      listSessions: () =>
        Promise.resolve(
          this.db.listMovedChats('here').map((c) => ({ sessionId: c.sessionId, mtime: c.at })),
        ),
      listSubkeys: (key) =>
        Promise.resolve(this.db.storeSubpaths(key.sessionId).filter((s) => s !== '')),
    };
    return this.sdk;
  }

  /**
   * Where the history of `sessionId` is read (`AgentAdapter` options): this
   * store, in the chat's folder here, for a chat that lives here; otherwise
   * Claude Code's local transcripts (`{}`).
   */
  historyOf(sessionId: string): HistoryOptions {
    const row = this.db.getMovedChat(sessionId);
    if (row?.state !== 'here') return {};
    return { ...(row.cwd === null ? {} : { dir: row.cwd }), sessionStore: this.sessionStore() };
  }

  /** Stores the entries of several keys of a chat in one transaction (an import). */
  put(sessionId: string, keys: KeyEntries[]): void {
    this.db.storeAppendKeys(
      sessionId,
      keys.map((k) => ({ subpath: toSubpath(k.subpath), entries: toRows(k.entries) })),
    );
  }

  /**
   * Makes these keys the chat's whole history, in one transaction: an import
   * replaces the old copy a machine kept of a chat that comes back (§6).
   */
  replace(sessionId: string, keys: KeyEntries[]): void {
    this.db.storeReplaceKeys(
      sessionId,
      keys.map((k) => ({ subpath: toSubpath(k.subpath), entries: toRows(k.entries) })),
    );
  }

  /** Every key of the chat with its entries, main transcript first (for a re-export). */
  entries(sessionId: string): KeyEntries[] {
    return this.db.storeSubpaths(sessionId).map((subpath) => {
      const entries = this.db.storeLoad(sessionId, subpath).map((r) => JSON.parse(r) as Entry);
      return subpath === '' ? { entries } : { subpath, entries };
    });
  }

  /** The chats that live here, with their folder. */
  here(): { sessionId: string; cwd: string }[] {
    return this.db
      .listMovedChats('here')
      .map((c) => ({ sessionId: c.sessionId, cwd: c.cwd ?? '' }));
  }

  isHere(sessionId: string): boolean {
    return this.db.getMovedChat(sessionId)?.state === 'here';
  }

  isAway(sessionId: string): boolean {
    return this.db.getMovedChat(sessionId)?.state === 'away';
  }

  /** Where an away chat went; null when it is not away. */
  awayTo(sessionId: string): MovePeer | null {
    const row = this.db.getMovedChat(sessionId);
    if (row?.state !== 'away' || row.peerMachineId === null) return null;
    return { machineId: row.peerMachineId, name: row.peerName ?? row.peerMachineId };
  }

  /** The chat now lives here, in `cwd`; it came `from` that machine. */
  markHere(sessionId: string, cwd: string, from: MovePeer): void {
    this.db.setMovedChat({
      sessionId,
      state: 'here',
      cwd,
      peerMachineId: from.machineId,
      peerName: from.name,
      at: this.now(),
    });
  }

  /** The chat went to `to`; its folder is kept. */
  markAway(sessionId: string, to: MovePeer): void {
    this.db.setMovedChat({
      sessionId,
      state: 'away',
      peerMachineId: to.machineId,
      peerName: to.name,
      at: this.now(),
    });
  }
}

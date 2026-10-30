import type { EventMsg } from '@pahub/protocol';
import type { AgentAdapter, SDKSessionInfo, SessionMessage } from '../sdk/adapter.js';
import { chunkText, type Db } from './db.js';
import {
  defaultGitCommonDir,
  displayNames,
  projectIdFor,
  projectPathFor,
  type GitCommonDir,
} from './projects.js';

/**
 * Cap on indexed text per session, in characters (~2 MB of mostly-ASCII text).
 * When a transcript has more, the most RECENT text (the tail) is kept and the
 * oldest is dropped: recent context is what people search for. The whole
 * transcript is still paged through (with event-loop yields) but only the tail
 * is held and indexed, which bounds index size and memory. The chat view is
 * unaffected: it reads messages from the SDK, not from the index.
 */
export const MAX_TEXT_CHARS = 2 * 1024 * 1024;

const BATCH = 20;
const PAGE = 100;
const DELETE_BATCH = 8;
const UNKNOWN_PROJECT = '(unknown)';

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const textOf = (m: SessionMessage): string => {
  if (m.type !== 'user' && m.type !== 'assistant') return '';
  const msg = m.message as { content?: unknown } | null | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as unknown[]) {
    const block = b as { type?: unknown; text?: unknown } | null;
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
};

/** User text and assistant text blocks only; tool use/results and thinking are skipped. */
export const extractText = (messages: SessionMessage[]): string =>
  messages.map(textOf).filter(Boolean).join('\n');

export type IndexerOptions = {
  platform?: NodeJS.Platform;
  gitCommonDir?: GitCommonDir;
  maxTextChars?: number;
  /** Called when one session fails to sync; the sync carries on with the rest. */
  onError?: (error: unknown, context: { sessionId: string; step: 'refresh' | 'sync' }) => void;
};

export class Indexer {
  private readonly platform: NodeJS.Platform;
  private readonly gitCommonDir: GitCommonDir;
  private readonly maxText: number;
  private readonly onError: NonNullable<IndexerOptions['onError']>;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly db: Db,
    private readonly emit: (e: EventMsg) => void,
    options: IndexerOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.gitCommonDir = options.gitCommonDir ?? defaultGitCommonDir;
    this.maxText = options.maxTextChars ?? MAX_TEXT_CHARS;
    this.onError = options.onError ?? (() => {});
  }

  /** Upserts every session's metadata and (re)indexes the ones that changed. */
  fullSync(): Promise<void> {
    return this.serial(async () => {
      const all = await this.adapter.listSessions();
      await this.process(all, true);
      this.removeVanished(new Set(all.map((i) => i.sessionId)));
    });
  }

  /** Re-reads the given sessions (e.g. after the watcher saw a transcript change). */
  refresh(sessionIds: string[]): Promise<void> {
    return this.serial(async () => {
      const infos: SDKSessionInfo[] = [];
      for (const id of sessionIds) {
        try {
          const info = await this.adapter.getSessionInfo(id);
          if (info) infos.push(info);
        } catch (e) {
          this.onError(e, { sessionId: id, step: 'refresh' });
        }
      }
      await this.process(infos, false);
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => {});
    return next;
  }

  private async process(infos: SDKSessionInfo[], progress: boolean): Promise<void> {
    const changed: string[] = [];
    const seenProjects = new Map<string, string>();
    let done = 0;
    for (let i = 0; i < infos.length; i += BATCH) {
      for (const info of infos.slice(i, i + BATCH)) {
        try {
          if (await this.one(info, seenProjects)) changed.push(info.sessionId);
        } catch (e) {
          this.onError(e, { sessionId: info.sessionId, step: 'sync' });
        }
        done++;
      }
      if (progress) this.emit({ event: 'index.progress', data: { done, total: infos.length } });
      await yieldLoop();
    }
    if (progress && infos.length === 0) {
      this.emit({ event: 'index.progress', data: { done: 0, total: 0 } });
    }
    try {
      this.syncProjects(seenProjects);
    } catch (e) {
      this.onError(e, { sessionId: '', step: 'sync' });
    }
    if (changed.length > 0) this.emit({ event: 'sessions.changed', data: { sessionIds: changed } });
  }

  /** Returns true when the session is new or anything about it changed. */
  private async one(info: SDKSessionInfo, seenProjects: Map<string, string>): Promise<boolean> {
    const projectId = info.cwd
      ? projectIdFor(info.cwd, this.platform, this.gitCommonDir)
      : UNKNOWN_PROJECT;
    if (!seenProjects.has(projectId)) {
      seenProjects.set(
        projectId,
        info.cwd ? projectPathFor(info.cwd, this.platform, this.gitCommonDir) : UNKNOWN_PROJECT,
      );
    }
    const before = this.db.getSession(info.sessionId);
    const stale = this.db.needsReindex(info);
    this.db.upsertSession(info, projectId);
    if (stale) {
      // A failure propagates: the session stays unmarked and is retried next sync.
      await this.indexText(info);
      this.db.markIndexed(info);
    }
    const after = this.db.getSession(info.sessionId);
    return (
      stale ||
      !before ||
      before.sdkTitle !== after?.sdkTitle ||
      before.summary !== after?.summary ||
      before.projectId !== after?.projectId
    );
  }

  /**
   * Pages through the whole transcript (yielding between pages) keeping only
   * the newest `maxText` characters, then writes them as a staged FTS
   * generation and swaps it in with one short statement. Any failure leaves the
   * previous index text intact.
   */
  private async indexText(info: SDKSessionInfo): Promise<void> {
    const id = info.sessionId;
    const parts: string[] = [];
    let total = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.adapter.getSessionMessages(id, { limit: PAGE, offset });
      if (page.length === 0) break;
      const text = extractText(page);
      if (text.length > 0) {
        parts.push(text);
        total += text.length;
        while (total > this.maxText) {
          const head = parts[0] as string;
          if (total - head.length >= this.maxText) {
            parts.shift();
            total -= head.length;
          } else {
            parts[0] = head.slice(total - this.maxText);
            total = this.maxText;
          }
        }
      }
      if (page.length < PAGE) break;
      await yieldLoop();
    }
    const stage = this.db.stageFts(id);
    try {
      for (const chunk of chunkText(parts.join('\n'))) {
        this.db.addFtsChunk(stage.key, chunk);
        await yieldLoop();
      }
      this.db.commitFts(id, stage.gen);
    } catch (e) {
      try {
        await this.dropStale(id);
      } catch (cleanup) {
        this.onError(cleanup, { sessionId: id, step: 'sync' }); // the original error is rethrown below
      }
      throw e;
    }
    await this.dropStale(id);
  }

  private async dropStale(sessionId: string): Promise<void> {
    const rowids = this.db.staleFtsRowids(sessionId);
    for (let i = 0; i < rowids.length; i += DELETE_BATCH) {
      this.db.deleteFtsRowids(rowids.slice(i, i + DELETE_BATCH));
      await yieldLoop();
    }
  }

  /** Deletes sessions that no longer exist in the SDK listing (never a live one) and empty projects. */
  private removeVanished(listed: Set<string>): void {
    const live = new Set(this.db.listLive().map((l) => l.sessionId));
    const removed: string[] = [];
    for (const id of this.db.allSessionIds()) {
      if (listed.has(id) || live.has(id)) continue;
      try {
        this.db.deleteSession(id);
        removed.push(id);
      } catch (e) {
        this.onError(e, { sessionId: id, step: 'sync' });
      }
    }
    if (removed.length === 0) return;
    const pruned = this.db.pruneEmptyProjects();
    this.emit({ event: 'sessions.changed', data: { sessionIds: removed } });
    if (pruned > 0) this.emit({ event: 'projects.changed', data: {} });
  }

  private syncProjects(seen: Map<string, string>): void {
    if (seen.size === 0) return;
    const known = new Map(this.db.listProjects().map((p) => [p.projectId, p.path]));
    for (const [projectId, path] of seen) known.set(projectId, path);
    const projects = [...known].map(([projectId, path]) => ({ projectId, path }));
    const names = displayNames(projects);
    let changed = false;
    const before = new Map(this.db.listProjects().map((p) => [p.projectId, p]));
    for (const p of projects) {
      const displayName = names.get(p.projectId) ?? p.path;
      const old = before.get(p.projectId);
      if (!old || old.path !== p.path || old.displayName !== displayName) {
        this.db.upsertProject({ ...p, displayName });
        changed = true;
      }
    }
    if (changed) this.emit({ event: 'projects.changed', data: {} });
  }
}

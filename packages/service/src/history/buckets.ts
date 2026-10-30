/**
 * v1.2 buckets (design §3): moving chats between Active, On hold and
 * Archived, tidying old chats away, bringing archived chats back when they
 * run again, and ending holds whose time ran out. Buckets are pahub's own
 * metadata (`pahub.db`), never written into Claude Code's data.
 */
import type { Bucket, ChatStatus, EventMsg } from '@pahub/protocol';
import type { ExternalSession } from '../external/poller.js';
import { externalStatus } from '../external/resume-safety.js';
import { isActiveNow, type Catalog } from './catalog.js';
import type { Db } from './db.js';

const DAY_MS = 86_400_000;

export type BucketsOptions = {
  db: Db;
  catalog: Catalog;
  emit: (e: EventMsg) => void;
  now?: () => number;
};

export type SetBucketResult = {
  updated: number;
  skipped: { sessionId: string; reason: string }[];
};

/** An external session in these states runs: it brings an archived chat back. */
const RUNNING: ReadonlySet<ChatStatus> = new Set(['working', 'needsYou']);

export class Buckets {
  private readonly db: Db;
  private readonly catalog: Catalog;
  private readonly emit: (e: EventMsg) => void;
  private readonly now: () => number;

  constructor(o: BucketsOptions) {
    this.db = o.db;
    this.catalog = o.catalog;
    this.emit = o.emit;
    this.now = o.now ?? Date.now;
  }

  /**
   * `chat.setBucket`: moves the known chats (one transaction). Archiving is
   * refused for a chat pahub runs (`LIVE`: the UI asks to end it first) or
   * one working or waiting elsewhere (`RUNNING`: it would come right back).
   * A hold whose time has already passed ends at once.
   */
  set(
    sessionIds: readonly string[],
    bucket: Bucket,
    hold: { until?: number | undefined; note?: string | undefined } = {},
  ): SetBucketResult {
    const ids = [...new Set(sessionIds)];
    const summaries = new Map(this.catalog.summaries(ids).map((s) => [s.sessionId, s]));
    const skipped: SetBucketResult['skipped'] = [];
    const moved: string[] = [];
    for (const id of ids) {
      const s = summaries.get(id);
      let reason: string | undefined;
      if (!s) reason = 'NOT_FOUND';
      else if (bucket === 'archived' && s.live) reason = 'LIVE';
      else if (bucket === 'archived' && s.external && RUNNING.has(s.status)) reason = 'RUNNING';
      if (reason) skipped.push({ sessionId: id, reason });
      else moved.push(id);
    }
    if (moved.length > 0) {
      this.db.setBucket(moved, bucket, hold);
      this.changed(moved, bucket);
      if (bucket === 'onHold' && hold.until !== undefined) this.sweepHolds();
    }
    return { updated: moved.length, skipped };
  }

  /**
   * `chat.archiveOlder`: archives (or with `dryRun` counts) the active chats
   * last active more than `olderThanDays` ago, of one project or of the
   * Active place (hidden projects left out). Chats in use, unread or back
   * from hold stay. One transaction.
   */
  archiveOlder(o: { projectId?: string | undefined; olderThanDays: number; dryRun?: boolean }): {
    archived: number;
  } {
    const before = this.now() - o.olderThanDays * DAY_MS;
    // Chats in use, and any the host saw active since the cut (their index row may lag).
    const keep = this.catalog
      .overlaySummaries()
      .filter((s) => isActiveNow(s) || s.lastActivity >= before)
      .map((s) => s.sessionId);
    const ids = this.db.archiveOlder({
      before,
      ...(o.projectId === undefined
        ? { excludeProjectIds: this.hiddenProjects() }
        : { projectId: o.projectId }),
      excludeIds: keep,
      ...(o.dryRun ? { dryRun: true } : {}),
    });
    if (!o.dryRun && ids.length > 0) this.changed(ids, 'archived');
    return { archived: ids.length };
  }

  /**
   * Auto-unarchive (§3): archived chats among `sessionIds` return to Active
   * (a message was sent to them, or they started running). Returns those.
   */
  unarchive(sessionIds: readonly string[]): string[] {
    const back = this.db.unarchive(sessionIds);
    if (back.length > 0) this.changed(back, 'active');
    return back;
  }

  /** Auto-unarchive (§3): external sessions that work or wait on the user. */
  unarchiveRunning(externals: readonly ExternalSession[]): void {
    const ids = externals.flatMap((e) =>
      e.sessionId !== undefined && RUNNING.has(externalStatus(e)) ? [e.sessionId] : [],
    );
    this.unarchive(ids);
  }

  /**
   * Ends the holds whose time ran out (call on a timer and at startup): the
   * chats return to Active, "back from hold", and are announced once each
   * (`chatBackFromHold`; the UI decides whether to notify).
   */
  sweepHolds(): void {
    const back = this.db.releaseHolds(this.now());
    if (back.length === 0) return;
    this.changed(back, 'active');
    const names = new Map(this.db.listProjects().map((p) => [p.projectId, p.displayName]));
    for (const s of this.catalog.summaries(back)) {
      this.emit({
        event: 'chatBackFromHold',
        data: {
          sessionId: s.sessionId,
          title: s.title,
          projectName: names.get(s.projectId) ?? '',
        },
      });
    }
  }

  private hiddenProjects(): string[] {
    return this.db
      .listProjects()
      .filter((p) => p.hidden)
      .map((p) => p.projectId);
  }

  private changed(sessionIds: string[], bucket: Bucket): void {
    this.catalog.bucketChanged(sessionIds, bucket);
    this.emit({ event: 'sessions.changed', data: { sessionIds } });
  }
}

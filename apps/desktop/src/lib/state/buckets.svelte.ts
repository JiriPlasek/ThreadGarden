/**
 * v1.2 §3 buckets: moving chats between Active, On hold and Archived, from
 * the chat list (row menu, keys, the bulk bar), the chat header and the quick
 * switcher. The dialogs this needs (the hold popover, "End this chat and
 * archive it?", the archive-older confirmation) and the notice for chats the
 * service skipped are hosted once, by `BucketDialogs` in the app shell.
 *
 * Lists, counts and the agents strip follow by themselves: the service sends
 * `sessions.changed` for every move.
 */
import type { Bucket, ChatSummary, Result } from '@threadgarden/protocol';
import type { Api } from './api';
import type { ChatsState } from './chats.svelte';

/** "Archive all older than 30 days" (the Older section's tidy action). */
export const ARCHIVE_OLDER_DAYS = 30;

/** A chat to move: what the dialogs and messages need of its summary. */
export type BucketTarget = Pick<ChatSummary, 'sessionId' | 'title'> &
  Partial<Pick<ChatSummary, 'bucket' | 'holdUntil' | 'holdNote' | 'status' | 'runningTasks'>>;

type Skipped = Result<'chat.setBucket'>['skipped'];

const VERBS: Record<Bucket, string> = {
  active: 'make active',
  onHold: 'put on hold',
  archived: 'archive',
};
const DONE: Record<Bucket, string> = {
  active: 'Made active',
  onHold: 'Put on hold',
  archived: 'Archived',
};

const chatsWord = (n: number): string => (n === 1 ? '1 chat' : `${n} chats`);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const target = (t: BucketTarget): BucketTarget => ({
  sessionId: t.sessionId,
  title: t.title,
  ...(t.bucket !== undefined ? { bucket: t.bucket } : {}),
  ...(t.holdUntil !== undefined ? { holdUntil: t.holdUntil } : {}),
  ...(t.holdNote !== undefined ? { holdNote: t.holdNote } : {}),
  ...(t.status !== undefined ? { status: t.status } : {}),
  ...(t.runningTasks !== undefined ? { runningTasks: t.runningTasks } : {}),
});

export class BucketsState {
  /** The hold popover is open for these chats. */
  holding = $state.raw<{ targets: BucketTarget[]; onSaved?: () => void } | null>(null);
  /** "End this chat and archive it?" is asked about this chat (Threadgarden runs it). */
  ending = $state.raw<BucketTarget | null>(null);
  /**
   * The archive-older confirmation, with the count of a dry run (summed over
   * the machines asked along, see `askArchiveOlder`).
   */
  archivingOlder = $state.raw<{ projectId?: string; count: number } | null>(null);
  /** What the last move could not do (chats the service skipped, a failure). */
  notice = $state<string | null>(null);

  private api: Api | null = null;
  /** The machines (this one first) with chats to archive in the open confirmation. */
  private olderOn: readonly BucketsState[] = [];
  private chats: Pick<ChatsState, 'end'> | null = null;

  init = (api: Api, chats: Pick<ChatsState, 'end'>): void => {
    this.api = api;
    this.chats = chats;
  };

  activate = (targets: readonly BucketTarget[]): Promise<void> => this.move(targets, 'active');

  /**
   * Archives the chats. A single chat Threadgarden runs is not archived but asked
   * about ("End this chat and archive it?"); in bulk, skipped chats are
   * reported in the notice instead.
   */
  archive = (targets: readonly BucketTarget[]): Promise<void> => this.move(targets, 'archived');

  /** Opens the hold popover; `onSaved` runs once the hold is saved. */
  hold = (targets: readonly BucketTarget[], onSaved?: () => void): void => {
    if (targets.length === 0) return;
    this.holding = { targets: targets.map(target), ...(onSaved ? { onSaved } : {}) };
  };

  /**
   * Saves the hold of the popover's chats. A failure is rethrown (the popover
   * stays open and shows it).
   */
  saveHold = async (hold: { until: number | undefined; note: string }): Promise<void> => {
    const h = this.holding;
    if (!h) return;
    const note = hold.note.trim();
    const r = await this.request(h.targets, 'onHold', {
      ...(hold.until !== undefined ? { holdUntil: hold.until } : {}),
      ...(note ? { holdNote: note } : {}),
    });
    if (this.holding === h) this.holding = null;
    h.onSaved?.();
    this.report(r.updated, r.skipped, 'onHold', h.targets);
  };

  closeHold = (): void => {
    this.holding = null;
  };

  /** The confirmed "End this chat and archive it?": `chat.end`, then archive again. */
  endAndArchive = async (): Promise<void> => {
    const t = this.ending;
    if (!t || !this.chats) return;
    await this.chats.end(t.sessionId);
    const r = await this.request([t], 'archived');
    this.ending = null;
    this.report(r.updated, r.skipped, 'archived', [t]);
  };

  cancelEnding = (): void => {
    this.ending = null;
  };

  /**
   * "Archive all older than 30 days" of a project, or of Active when
   * `projectId` is undefined: counts first (dry run) for the confirmation.
   * `along`: other machines' buckets whose Active is tidied too (Active
   * across machines); the confirmation counts them all, and a machine that
   * cannot count is left out (unless none can).
   */
  askArchiveOlder = async (
    projectId: string | undefined,
    along: readonly BucketsState[] = [],
  ): Promise<void> => {
    if (!this.api) return;
    const all = [this, ...along];
    const counts = await Promise.allSettled(all.map((b) => b.archiveOlderOn(projectId, true)));
    const parts = counts.flatMap((r, i) =>
      r.status === 'fulfilled' && r.value > 0 ? [{ buckets: all[i]!, count: r.value }] : [],
    );
    const failed = counts.find((r) => r.status === 'rejected');
    if (parts.length === 0) {
      this.notice = failed
        ? `Could not count the older chats: ${message(failed.reason)}`
        : `No chats older than ${ARCHIVE_OLDER_DAYS} days to archive (running, waiting and unread chats stay).`;
      return;
    }
    this.olderOn = parts.map((p) => p.buckets);
    this.archivingOlder = {
      ...(projectId !== undefined ? { projectId } : {}),
      count: parts.reduce((n, p) => n + p.count, 0),
    };
  };

  /**
   * The confirmed archive-older: each machine archives its own. A failure is
   * rethrown (the confirmation shows it; trying again archives what is left).
   */
  archiveOlder = async (): Promise<void> => {
    const o = this.archivingOlder;
    if (!o || !this.api) return;
    const done = await Promise.allSettled(
      this.olderOn.map((b) => b.archiveOlderOn(o.projectId, false)),
    );
    const failed = done.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const archived = done.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
    this.archivingOlder = null;
    // Time passed since the count (chats were read, or started running): say what happened.
    this.notice = `Archived ${chatsWord(archived)}.`;
  };

  /** `chat.archiveOlder` on this machine; `dryRun`: counts only. */
  private archiveOlderOn = async (
    projectId: string | undefined,
    dryRun: boolean,
  ): Promise<number> => {
    if (!this.api) throw new Error('Not connected to the Threadgarden service');
    const { archived } = await this.api.request('chat.archiveOlder', {
      ...(projectId !== undefined ? { projectId } : {}),
      olderThanDays: ARCHIVE_OLDER_DAYS,
      ...(dryRun ? { dryRun: true } : {}),
    });
    return archived;
  };

  cancelArchiveOlder = (): void => {
    this.archivingOlder = null;
  };

  dismissNotice = (): void => {
    this.notice = null;
  };

  private move = async (targets: readonly BucketTarget[], bucket: Bucket): Promise<void> => {
    if (targets.length === 0) return;
    const list = targets.map(target);
    try {
      const r = await this.request(list, bucket);
      const live = r.skipped.filter((s) => s.reason === 'LIVE');
      if (bucket === 'archived' && list.length === 1 && live.length === 1) {
        this.ending = list[0]!;
        return;
      }
      this.report(r.updated, r.skipped, bucket, list);
    } catch (err) {
      this.notice = `Could not ${VERBS[bucket]} ${list.length === 1 ? 'the chat' : chatsWord(list.length)}: ${message(err)}`;
    }
  };

  private request = async (
    targets: readonly BucketTarget[],
    bucket: Bucket,
    hold: { holdUntil?: number; holdNote?: string } = {},
  ): Promise<Result<'chat.setBucket'>> => {
    if (!this.api) throw new Error('Not connected to the Threadgarden service');
    this.notice = null;
    return this.api.request('chat.setBucket', {
      sessionIds: targets.map((t) => t.sessionId),
      bucket,
      ...hold,
    });
  };

  /** Says what was skipped (nothing when everything moved). */
  private report = (
    updated: number,
    skipped: Skipped,
    bucket: Bucket,
    targets: readonly BucketTarget[],
  ): void => {
    if (skipped.length === 0) return;
    const titleOf = (id: string): string =>
      targets.find((t) => t.sessionId === id)?.title ?? 'The chat';
    const live = skipped.filter((s) => s.reason === 'LIVE');
    const running = skipped.filter((s) => s.reason === 'RUNNING');
    const other = skipped.length - live.length - running.length;
    const parts: string[] = [];
    if (updated > 0) parts.push(`${DONE[bucket]} ${chatsWord(updated)}.`);
    if (live.length > 0) {
      parts.push(
        `${chatsWord(live.length)} ${live.length === 1 ? 'was' : 'were'} not archived because Threadgarden is running ${live.length === 1 ? 'it' : 'them'}; end ${live.length === 1 ? 'it' : 'them'} first.`,
      );
    }
    if (running.length === 1 && targets.length === 1) {
      parts.push(
        `“${titleOf(running[0]!.sessionId)}” is running outside Threadgarden. Stop it there, then archive it.`,
      );
    } else if (running.length > 0) {
      parts.push(
        `${chatsWord(running.length)} ${running.length === 1 ? 'runs' : 'run'} outside Threadgarden and ${running.length === 1 ? 'was' : 'were'} not archived; stop ${running.length === 1 ? 'it' : 'them'} there first.`,
      );
    }
    if (other > 0) parts.push(`${chatsWord(other)} could not be moved (no longer found).`);
    this.notice = parts.join(' ');
  };
}

export const buckets = new BucketsState();

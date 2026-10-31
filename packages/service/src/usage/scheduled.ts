/**
 * Scheduled sends (v1.3 B, spec §3): messages the service sends to a chat
 * later, stored in `pahub.db` (`scheduled_sends`) so they survive restarts.
 *
 * A due send goes out through the same path as `chat.send` (resuming the
 * chat when Threadgarden is not running it). A chat's sends go out in order, one
 * per turn: the next one waits while the chat works or waits on the user,
 * and until the turn the previous one started has ended. While the account
 * is known to be refused (a rejected window whose reset is ahead), a due send
 * moves to that reset plus `LIMIT_RESET_MARGIN_MS` instead of being refused.
 * A send the limit still refuses is moved to the new reset once; after that
 * it stays as `failed` until the user sends it again or cancels it.
 *
 * Sends due while the service was not running go out at the next start,
 * marked late. One that was going out when the service stopped is not sent
 * again (it may have gone out): it becomes `failed`, for the user to check.
 *
 * One timer (via `Timers`) waits for the earliest due send, capped so clock
 * changes and sleep are caught up; `check()` also runs on the service's
 * minute tick.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  LIMIT_RESET_MARGIN_MS,
  type ChatStatus,
  type EventMsg,
  type ImageRef,
  type ScheduledSend,
} from '@pahub/protocol';
import type { Timers } from '../chat/live-session.js';
import { ServiceError } from '../server/router.js';

/** Longest single wait of the timer; it re-checks then (sleep, clock changes). */
export const MAX_TIMER_MS = 60 * 60_000;

export const STOPPED_WHILE_SENDING =
  'Threadgarden stopped while this message was going out. Check the chat, then send it again if it is missing.';
export const LIMIT_STILL_REACHED = 'The usage limit was still reached when this message went out.';
export const LIMIT_RESET_UNKNOWN =
  'The usage limit refused this message, and when it resets is not known.';
export const CHAT_STOPPED = 'The chat stopped before Claude answered this message.';

export type ScheduledDeps = {
  raw: DatabaseSync;
  now: () => number;
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  emit: (e: EventMsg) => void;
  /** `chat.send`: resumes the chat when needed; rejects with the reason it could not send. */
  send: (sessionId: string, text: string, images: ImageRef[]) => Promise<unknown>;
  /** The chat is in a turn (working, or waiting on the user): a new message would only queue. */
  busy: (sessionId: string) => boolean;
  /** The reset time of the usage limit refusing requests now, if one does and it is known. */
  limitResetAt: () => number | undefined;
  /** A chat Threadgarden knows (`NOT_FOUND` otherwise). */
  exists: (sessionId: string) => boolean;
  describe: (sessionId: string) => { title: string; projectName: string };
  /** Says in the chat that a scheduled message went out late. */
  noteLate: (sessionId: string, dueAt: number) => void;
  onError: (err: unknown, context: string) => void;
};

type Row = {
  id: string;
  session_id: string;
  text: string;
  images: string | null;
  send_at: number;
  created_at: number;
  state: string;
  after_reset: number;
  rescheduled: number;
  late: number;
  error: string | null;
};

const STATES = new Set(['pending', 'sending', 'failed']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const imagesOf = (json: string | null): ImageRef[] => {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter(
          (i): i is ImageRef =>
            typeof i === 'object' &&
            i !== null &&
            typeof (i as ImageRef).mediaType === 'string' &&
            typeof (i as ImageRef).data === 'string',
        )
      : [];
  } catch {
    return [];
  }
};

const toSend = (r: Row): ScheduledSend => ({
  id: r.id,
  sessionId: r.session_id,
  text: r.text,
  imageCount: imagesOf(r.images).length,
  sendAt: r.send_at,
  createdAt: r.created_at,
  state: (STATES.has(r.state) ? r.state : 'failed') as ScheduledSend['state'],
  afterLimitReset: r.after_reset === 1,
  rescheduled: r.rescheduled === 1,
  ...(r.error ? { error: r.error } : {}),
  ...(r.late === 1 ? { late: true } : {}),
});

const ORDER = 'ORDER BY send_at, created_at, rowid';

export type When = { sendAt?: number | undefined; whenLimitResets?: true | undefined };

export class ScheduledSends {
  private timer: unknown = undefined;
  private disposed = false;
  /** Chats whose scheduled message is out and whose turn has not ended: id of that send. */
  private readonly inFlight = new Map<string, string>();

  constructor(private readonly deps: ScheduledDeps) {}

  /**
   * At service start: a send that was going out is not sent again (it may
   * have gone out), and the sends that fell due meanwhile are marked late;
   * then the due ones go out.
   */
  start(): void {
    const { raw } = this.deps;
    const now = this.deps.now();
    raw
      .prepare(`UPDATE scheduled_sends SET state = 'failed', error = ? WHERE state = 'sending'`)
      .run(STOPPED_WHILE_SENDING);
    raw
      .prepare(`UPDATE scheduled_sends SET late = 1 WHERE state = 'pending' AND send_at <= ?`)
      .run(now);
    this.changed();
    this.check();
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  list(sessionId?: string): ScheduledSend[] {
    const rows =
      sessionId === undefined
        ? this.deps.raw.prepare(`SELECT * FROM scheduled_sends ${ORDER}`).all()
        : this.deps.raw
            .prepare(`SELECT * FROM scheduled_sends WHERE session_id = ? ${ORDER}`)
            .all(sessionId);
    return (rows as Row[]).map(toSend);
  }

  get(id: string): ScheduledSend & { images: ImageRef[] } {
    const r = this.row(id);
    return { ...toSend(r), images: imagesOf(r.images) };
  }

  /** Sends that still wait for their time (they keep the service from exiting on idle). */
  pendingCount(): number {
    const r = this.deps.raw
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_sends WHERE state IN ('pending', 'sending')`)
      .get() as { n: number };
    return r.n;
  }

  create(p: { sessionId: string; text: string; images?: ImageRef[] | undefined } & When) {
    if (!this.deps.exists(p.sessionId)) {
      throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    }
    const images = p.images ?? [];
    if (p.text.trim() === '' && images.length === 0) {
      throw new ServiceError('INVALID_PARAMS', 'A scheduled message needs text or an image');
    }
    const { sendAt, afterReset } = this.when(p);
    const id = randomUUID();
    this.deps.raw
      .prepare(
        `INSERT INTO scheduled_sends (id, session_id, text, images, send_at, created_at, after_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.sessionId,
        p.text,
        images.length > 0 ? JSON.stringify(images) : null,
        sendAt,
        this.deps.now(),
        afterReset ? 1 : 0,
      );
    this.changed();
    this.check();
    return toSend(this.row(id));
  }

  /**
   * Edits a send that has not gone out. A new time also gives a failed send
   * (and one moved after a refusal) a fresh start.
   */
  update(p: { id: string; text?: string | undefined; images?: ImageRef[] | undefined } & When) {
    const r = this.row(p.id);
    if (r.state === 'sending') {
      throw new ServiceError('ALREADY_SENT', 'This message has already gone out');
    }
    const text = p.text ?? r.text;
    const images = p.images ?? imagesOf(r.images);
    if (text.trim() === '' && images.length === 0) {
      throw new ServiceError('INVALID_PARAMS', 'A scheduled message needs text or an image');
    }
    const retimed = p.sendAt !== undefined || p.whenLimitResets === true;
    const { sendAt, afterReset } = retimed
      ? this.when(p)
      : { sendAt: r.send_at, afterReset: r.after_reset === 1 };
    this.deps.raw
      .prepare(
        `UPDATE scheduled_sends SET text = ?1, images = ?2, send_at = ?3, after_reset = ?4,
           state = CASE WHEN ?5 THEN 'pending' ELSE state END,
           rescheduled = CASE WHEN ?5 THEN 0 ELSE rescheduled END,
           error = CASE WHEN ?5 THEN NULL ELSE error END,
           late = CASE WHEN ?5 THEN 0 ELSE late END
         WHERE id = ?6`,
      )
      .run(
        text,
        images.length > 0 ? JSON.stringify(images) : null,
        sendAt,
        afterReset ? 1 : 0,
        retimed ? 1 : 0,
        p.id,
      );
    this.changed();
    this.check();
    return toSend(this.row(p.id));
  }

  cancel(id: string): void {
    const r = this.row(id);
    if (r.state === 'sending') {
      throw new ServiceError('ALREADY_SENT', 'This message has already gone out');
    }
    this.deps.raw.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(id);
    this.changed();
    this.check();
  }

  /** Sends it now, limit or not (the user asked); a failure is this call's error too. */
  async sendNow(id: string): Promise<void> {
    const r = this.row(id);
    if (r.state === 'sending') {
      throw new ServiceError('ALREADY_SENT', 'This message has already gone out');
    }
    if (this.inFlight.has(r.session_id)) {
      throw new ServiceError('BUSY', 'Another scheduled message of this chat is going out');
    }
    await this.fire(r, true);
  }

  /**
   * A turn of `sessionId` ended. Its scheduled message (if it started the
   * turn) is done, unless a usage limit refused it: then it waits for the new
   * reset, once.
   */
  turnEnded(sessionId: string, refused: boolean): void {
    const id = this.inFlight.get(sessionId);
    this.inFlight.delete(sessionId);
    if (id !== undefined) {
      if (!refused) {
        this.deps.raw.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(id);
      } else {
        this.refusedAgain(id);
      }
      this.changed();
    }
    this.check();
  }

  /** A chat's status changed: it may be free for its next send, or have stopped mid-turn. */
  statusChanged(sessionId: string, status: ChatStatus): void {
    const id = this.inFlight.get(sessionId);
    if (id !== undefined && (status === 'failed' || status === 'history' || status === 'paused')) {
      this.inFlight.delete(sessionId);
      if (status === 'failed') {
        this.deps.raw
          .prepare(`UPDATE scheduled_sends SET state = 'failed', error = ? WHERE id = ?`)
          .run(CHAT_STOPPED, id);
      } else {
        // Ended or reclaimed by the user's choice: the message went out.
        this.deps.raw.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(id);
      }
      this.changed();
    }
    if (status === 'idle' || status === 'failed' || status === 'history' || status === 'paused') {
      this.check();
    }
  }

  /** Sends what is due (one per chat that is free), then waits for the next. */
  check(): void {
    if (this.disposed) return;
    this.disarm();
    const now = this.deps.now();
    const due = this.deps.raw
      .prepare(`SELECT * FROM scheduled_sends WHERE state = 'pending' AND send_at <= ? ${ORDER}`)
      .all(now) as Row[];
    const taken = new Set<string>();
    for (const r of due) {
      if (taken.has(r.session_id)) continue;
      taken.add(r.session_id);
      if (this.blocked(r.session_id)) continue;
      const reset = this.deps.limitResetAt();
      if (reset !== undefined && reset > now) {
        // Known to be refused until then: wait for the reset rather than be refused.
        this.deps.raw
          .prepare('UPDATE scheduled_sends SET send_at = ?, after_reset = 1 WHERE id = ?')
          .run(reset + LIMIT_RESET_MARGIN_MS, r.id);
        this.changed();
        continue;
      }
      void this.fire(r, false).catch(() => {
        // Recorded on the send (`failed` with the reason).
      });
    }
    this.arm();
  }

  private blocked(sessionId: string): boolean {
    try {
      return this.inFlight.has(sessionId) || this.deps.busy(sessionId);
    } catch (err) {
      this.deps.onError(err, 'scheduled send (busy)');
      return true;
    }
  }

  /** Sends one; `failed` with the reason when it could not go out. */
  private async fire(r: Row, now: boolean): Promise<void> {
    this.inFlight.set(r.session_id, r.id);
    this.deps.raw
      .prepare(`UPDATE scheduled_sends SET state = 'sending', error = NULL WHERE id = ?`)
      .run(r.id);
    this.changed();
    try {
      await this.deps.send(r.session_id, r.text, imagesOf(r.images));
    } catch (err) {
      if (this.inFlight.get(r.session_id) === r.id) this.inFlight.delete(r.session_id);
      if (!this.disposed) {
        this.deps.raw
          .prepare(`UPDATE scheduled_sends SET state = 'failed', error = ? WHERE id = ?`)
          .run(errorText(err), r.id);
        this.changed();
        this.arm();
      }
      throw err;
    }
    if (this.disposed) return;
    const late = r.late === 1 && !now;
    if (late) this.guard('late note', () => this.deps.noteLate(r.session_id, r.send_at));
    this.guard('scheduledSent', () =>
      this.deps.emit({
        event: 'scheduledSent',
        data: {
          sessionId: r.session_id,
          ...this.deps.describe(r.session_id),
          late,
          dueAt: r.send_at,
        },
      }),
    );
  }

  /** The limit refused a send that went out: the new reset once, then `failed`. */
  private refusedAgain(id: string): void {
    const r = this.deps.raw.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id) as
      Row | undefined;
    if (!r) return;
    const reset = this.deps.limitResetAt();
    if (r.rescheduled === 1 || reset === undefined) {
      this.deps.raw
        .prepare(`UPDATE scheduled_sends SET state = 'failed', error = ? WHERE id = ?`)
        .run(
          reset === undefined && r.rescheduled !== 1 ? LIMIT_RESET_UNKNOWN : LIMIT_STILL_REACHED,
          id,
        );
      return;
    }
    this.deps.raw
      .prepare(
        `UPDATE scheduled_sends SET state = 'pending', send_at = ?, after_reset = 1,
           rescheduled = 1, late = 0, error = NULL WHERE id = ?`,
      )
      .run(reset + LIMIT_RESET_MARGIN_MS, id);
  }

  private when(p: When): { sendAt: number; afterReset: boolean } {
    if (p.whenLimitResets === true) {
      const reset = this.deps.limitResetAt();
      if (reset === undefined) {
        throw new ServiceError('NO_RESET_TIME', 'When the usage limit resets is not known');
      }
      return { sendAt: reset + LIMIT_RESET_MARGIN_MS, afterReset: true };
    }
    if (p.sendAt === undefined || !Number.isFinite(p.sendAt)) {
      throw new ServiceError('INVALID_PARAMS', 'sendAt or whenLimitResets is required');
    }
    return { sendAt: p.sendAt, afterReset: false };
  }

  private row(id: string): Row {
    const r = this.deps.raw.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id) as
      Row | undefined;
    if (!r) throw new ServiceError('NOT_FOUND', 'This scheduled message was sent or cancelled');
    return r;
  }

  /** Waits for the earliest pending send of a chat that is free (busy ones are woken by status). */
  private arm(): void {
    if (this.disposed) return;
    this.disarm();
    const rows = this.deps.raw
      .prepare(`SELECT session_id, send_at FROM scheduled_sends WHERE state = 'pending' ${ORDER}`)
      .all() as Pick<Row, 'session_id' | 'send_at'>[];
    const now = this.deps.now();
    const next = rows.find((r) => r.send_at > now || !this.blocked(r.session_id));
    if (!next) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next.send_at - now));
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = undefined;
      this.guard('scheduled sends', () => this.check());
    }, delay);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    this.guard('scheduled.changed', () =>
      this.deps.emit({ event: 'scheduled.changed', data: { items: this.list() } }),
    );
  }

  private guard(context: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.onError(err, context);
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ImageRefSchema, type AwayItem, type ImageRef } from '@threadgarden/protocol';
import { z } from 'zod';
import { ServiceError } from '../server/router.js';

/** What a queued row sends: `chat.send`'s or `chat.create`'s params, less the ids. */
const PayloadSchema = z.object({
  text: z.string(),
  images: z.array(ImageRefSchema).optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
});
export type AwayPayload = z.infer<typeof PayloadSchema>;

export type AwayKind = AwayItem['kind'];
export type AwayReason = NonNullable<AwayItem['reason']>;

/** A queued row with what it sends; `payload` is null when it no longer reads back. */
export type AwayRow = AwayItem & { payload: AwayPayload | null };

export type NewAwayRow = {
  machineId: string;
  sessionId: string;
  kind: AwayKind;
  text: string;
  images?: ImageRef[] | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  effort?: string | undefined;
};

type Row = {
  id: string;
  machine_id: string;
  session_id: string;
  kind: string;
  payload: string;
  created_at: number;
  state: string;
  reason: string | null;
  error: string | null;
};

export const ALREADY_SENT_MESSAGE = 'This message has already gone out';

/** Written order (`seq`), never the clock: a clock set back must not reorder a chat. */
const ORDER = 'ORDER BY seq';

const readPayload = (json: string): AwayPayload | null => {
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const toRow = (r: Row): AwayRow => {
  const payload = readPayload(r.payload);
  return {
    id: r.id,
    machineId: r.machine_id,
    sessionId: r.session_id,
    kind: r.kind === 'create' ? 'create' : 'send',
    text: payload?.text ?? '',
    imageCount: payload?.images?.length ?? 0,
    cwd: payload?.cwd ?? null,
    createdAt: r.created_at,
    state: r.state === 'waiting' || r.state === 'sending' ? r.state : 'failed',
    reason: r.reason === 'start' || r.reason === 'refused' ? r.reason : null,
    error: r.error,
    payload,
  };
};

const toItem = (row: AwayRow): AwayItem => {
  const { payload, ...item } = row;
  void payload;
  return item;
};

/**
 * Messages written for a machine this desktop is not connected to, in the
 * local service's database (`away_queue`) so they outlive the window and the
 * service. A row leaves only when the machine accepted it, or the owner
 * cancelled it. Its `id` is a UUID made here once, and is the message's id on
 * the machine (`chat.send`'s `messageId`), so sending it again is harmless.
 */
export class AwayQueue {
  constructor(
    private readonly raw: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** Writes a row down, `waiting`, or `failed` with the failure it joins. */
  add(p: NewAwayRow, failed?: { reason: AwayReason; error: string | null }): AwayItem {
    const payload: AwayPayload = {
      text: p.text,
      ...(p.images && p.images.length > 0 ? { images: p.images } : {}),
      ...(p.cwd === undefined ? {} : { cwd: p.cwd }),
      ...(p.model === undefined ? {} : { model: p.model }),
      ...(p.permissionMode === undefined ? {} : { permissionMode: p.permissionMode }),
      ...(p.effort === undefined ? {} : { effort: p.effort }),
    };
    const id = this.newId();
    this.raw
      .prepare(
        `INSERT INTO away_queue (id, seq, machine_id, session_id, kind, payload, created_at, state, reason, error)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM away_queue), ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.machineId,
        p.sessionId,
        p.kind,
        JSON.stringify(payload),
        this.now(),
        failed ? 'failed' : 'waiting',
        failed?.reason ?? null,
        failed?.error ?? null,
      );
    return toItem(this.get(id)!);
  }

  get(id: string): AwayRow | null {
    const r = this.raw.prepare('SELECT * FROM away_queue WHERE id = ?').get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** One machine's rows, or every one's, in the order they go out. */
  rows(machineId?: string): AwayRow[] {
    const rows = (
      machineId === undefined
        ? this.raw.prepare(`SELECT * FROM away_queue ${ORDER}`).all()
        : this.raw.prepare(`SELECT * FROM away_queue WHERE machine_id = ? ${ORDER}`).all(machineId)
    ) as Row[];
    return rows.map(toRow);
  }

  list(machineId?: string): AwayItem[] {
    return this.rows(machineId).map(toItem);
  }

  /** The machines with rows waiting to go out. */
  waitingMachines(): string[] {
    const rows = this.raw
      .prepare(
        "SELECT machine_id FROM away_queue WHERE state = 'waiting' GROUP BY machine_id ORDER BY MIN(seq)",
      )
      .all() as { machine_id: string }[];
    return rows.map((r) => r.machine_id);
  }

  hasWaiting(): boolean {
    return (
      this.raw.prepare("SELECT 1 FROM away_queue WHERE state = 'waiting' LIMIT 1").get() !==
      undefined
    );
  }

  /** Marks a waiting row as going out; false when it is not waiting (any more). */
  claim(id: string): boolean {
    const r = this.raw
      .prepare("UPDATE away_queue SET state = 'sending' WHERE id = ? AND state = 'waiting'")
      .run(id);
    return Number(r.changes) > 0;
  }

  /** Back to waiting (the link was lost on the way: it goes again, with the same id). */
  release(id: string): void {
    this.raw.prepare("UPDATE away_queue SET state = 'waiting' WHERE id = ?").run(id);
  }

  fail(id: string, reason: AwayReason, error: string | null): void {
    this.raw
      .prepare("UPDATE away_queue SET state = 'failed', reason = ?, error = ? WHERE id = ?")
      .run(reason, error, id);
  }

  /** Every waiting row of the machine fails (its start ran out). */
  failWaiting(machineId: string, reason: AwayReason, error: string | null): void {
    this.raw
      .prepare(
        "UPDATE away_queue SET state = 'failed', reason = ?, error = ? WHERE machine_id = ? AND state = 'waiting'",
      )
      .run(reason, error, machineId);
  }

  /** The machine accepted it: the row is done. */
  remove(id: string): void {
    this.raw.prepare('DELETE FROM away_queue WHERE id = ?').run(id);
  }

  /** The owner took a row back; one going out is the machine's already. False: no such row. */
  cancel(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.state === 'sending') throw new ServiceError('ALREADY_SENT', ALREADY_SENT_MESSAGE);
    this.remove(id);
    return true;
  }

  /** The machine's failed rows (only those failed for `reason`, if given) wait again; false when none did. */
  retry(machineId: string, reason?: AwayReason): boolean {
    const r = this.raw
      .prepare(
        `UPDATE away_queue SET state = 'waiting', reason = NULL, error = NULL
         WHERE machine_id = ? AND state = 'failed' AND (? IS NULL OR reason = ?)`,
      )
      .run(machineId, reason ?? null, reason ?? null);
    return Number(r.changes) > 0;
  }

  /**
   * Rows left `sending` by a service that stopped meanwhile wait again: the
   * machine may have them, and their ids make sending them again harmless.
   */
  resetSending(): void {
    this.raw.prepare("UPDATE away_queue SET state = 'waiting' WHERE state = 'sending'").run();
  }

  /** Drops a machine's rows (it was removed). */
  forget(machineId: string): void {
    this.raw.prepare('DELETE FROM away_queue WHERE machine_id = ?').run(machineId);
  }
}

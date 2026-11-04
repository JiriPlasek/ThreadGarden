import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import {
  ChatCopySchema,
  CopyItemSchema,
  MachineCopySchema,
  type ChatCopy,
  type ChatSummary,
  type CopyItem,
  type MachineCopy,
  type MachineInfo,
  type Project,
} from '@threadgarden/protocol';

/** Chats kept per machine, the most recently active. */
export const COPY_CHATS = 500;
/** Items kept per chat copy: the last few things said. */
export const COPY_ITEMS = 10;

/**
 * What the desktop keeps of each paired machine (its lists and the last
 * messages of its chats), so they can be read while the machine is off. The
 * limits are held here whatever the client sends.
 */
export class CopyStore {
  constructor(
    private readonly raw: DatabaseSync,
    private readonly now: () => number = Date.now,
    /** Where a stored copy that no longer reads back is reported. */
    private readonly log?: { warn(message: string): void },
  ) {}

  /** Replaces the machine's lists; chat copies no longer listed go with them. */
  saveLists(lists: {
    machineId: string;
    info: MachineInfo | null;
    projects: Project[];
    chats: ChatSummary[];
  }): void {
    const chats = [...lists.chats]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, COPY_CHATS);
    const copy: MachineCopy = {
      machineId: lists.machineId,
      info: lists.info,
      projects: lists.projects,
      chats,
      copiedAt: this.now(),
    };
    this.inTransaction(() => {
      this.raw
        .prepare(
          'INSERT OR REPLACE INTO machine_copies (machine_id, json, copied_at) VALUES (?, ?, ?)',
        )
        .run(lists.machineId, JSON.stringify(copy), copy.copiedAt);
      const keep = new Set(chats.map((c) => c.sessionId));
      const rows = this.raw
        .prepare('SELECT session_id FROM chat_copies WHERE machine_id = ?')
        .all(lists.machineId) as { session_id: string }[];
      const drop = this.raw.prepare(
        'DELETE FROM chat_copies WHERE machine_id = ? AND session_id = ?',
      );
      for (const r of rows) if (!keep.has(r.session_id)) drop.run(lists.machineId, r.session_id);
    });
  }

  /** Replaces one chat's copy, keeping the last few user, assistant and permission items. */
  saveChat(chat: {
    machineId: string;
    sessionId: string;
    summary: ChatSummary;
    items: unknown[];
  }): void {
    const items: CopyItem[] = [];
    for (const item of chat.items) {
      const parsed = CopyItemSchema.safeParse(item);
      if (parsed.success) items.push(parsed.data);
    }
    const copy: ChatCopy = {
      machineId: chat.machineId,
      sessionId: chat.sessionId,
      summary: chat.summary,
      items: items.slice(-COPY_ITEMS),
      copiedAt: this.now(),
    };
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO chat_copies (machine_id, session_id, json, last_activity, copied_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        chat.machineId,
        chat.sessionId,
        JSON.stringify(copy),
        chat.summary.lastActivity,
        copy.copiedAt,
      );
  }

  get(machineId: string): MachineCopy | null {
    const row = this.raw
      .prepare('SELECT json FROM machine_copies WHERE machine_id = ?')
      .get(machineId) as { json: string } | undefined;
    return row ? this.read(row.json, MachineCopySchema, `machine ${machineId}`) : null;
  }

  chat(machineId: string, sessionId: string): ChatCopy | null {
    const row = this.raw
      .prepare('SELECT json FROM chat_copies WHERE machine_id = ? AND session_id = ?')
      .get(machineId, sessionId) as { json: string } | undefined;
    return row ? this.read(row.json, ChatCopySchema, `chat ${sessionId} of ${machineId}`) : null;
  }

  /**
   * A stored copy, or null when it no longer reads back (written by another
   * version, or damaged): the copy is only a convenience, and the next refresh
   * replaces it, so it is skipped rather than failing the caller.
   */
  private read<T>(json: string, schema: z.ZodType<T>, what: string): T | null {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      this.log?.warn(`copies: the copy of ${what} is not JSON; skipped`);
      return null;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    this.log?.warn(`copies: the copy of ${what} no longer reads back; skipped`);
    return null;
  }

  /** Each copied chat's `lastActivity`, by session id: what the copy already has. */
  tails(machineId: string): Record<string, number> {
    const rows = this.raw
      .prepare('SELECT session_id, last_activity FROM chat_copies WHERE machine_id = ?')
      .all(machineId) as { session_id: string; last_activity: number | null }[];
    const out: Record<string, number> = {};
    for (const r of rows) if (r.last_activity !== null) out[r.session_id] = r.last_activity;
    return out;
  }

  /** Drops everything kept of a machine (it was removed). */
  forget(machineId: string): void {
    this.inTransaction(() => {
      this.raw.prepare('DELETE FROM machine_copies WHERE machine_id = ?').run(machineId);
      this.raw.prepare('DELETE FROM chat_copies WHERE machine_id = ?').run(machineId);
    });
  }

  private inTransaction(fn: () => void): void {
    this.raw.exec('BEGIN');
    try {
      fn();
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }
}

import type { DatabaseSync } from 'node:sqlite';
import type { PairedMachine } from '@threadgarden/protocol';

/** A paired machine with what stays in the service: its pinned certificate and this device's id there. */
export type StoredMachine = PairedMachine & { certPem: string; deviceId: string };
export type NewMachine = Omit<StoredMachine, 'unlocked'>;

type Row = {
  id: string;
  name: string;
  address: string;
  port: number;
  cert_pem: string;
  fingerprint: string;
  device_id: string;
  added_at: number;
};

const COLUMNS = 'id, name, address, port, cert_pem, fingerprint, device_id, added_at';

/**
 * The machines this one pairs with and connects to. They live in the
 * database; their device tokens live in memory only, like the API key: the UI
 * keeps them in the OS keychain and hands them over with `machines.unlock`
 * after every service start. A machine without its token is locked.
 */
export class PairedMachines {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly db: DatabaseSync) {}

  list(): PairedMachine[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM machines ORDER BY sort, added_at, id`)
      .all() as Row[];
    return rows.map((r) => this.toMachine(r));
  }

  get(id: string): StoredMachine | null {
    const r = this.row(id);
    return r ? { ...this.toMachine(r), certPem: r.cert_pem, deviceId: r.device_id } : null;
  }

  /** Adds a machine after the others. */
  add(m: NewMachine): void {
    this.db
      .prepare(
        `INSERT INTO machines (${COLUMNS}, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort) + 1, 0) FROM machines))`,
      )
      .run(m.id, m.name, m.address, m.port, m.certPem, m.fingerprint, m.deviceId, m.addedAt);
  }

  /** Renames or moves a machine; its pin stays. Throws for an unknown machine. */
  update(id: string, patch: { name?: string; address?: string; port?: number }): PairedMachine {
    const current = this.row(id);
    if (!current) throw new Error(`unknown machine ${id}`);
    this.db
      .prepare('UPDATE machines SET name = ?, address = ?, port = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.address ?? current.address,
        patch.port ?? current.port,
        id,
      );
    return this.toMachine(this.row(id)!);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
    this.tokens.delete(id);
  }

  /** Holds the machine's token until the service stops. Throws for an unknown machine. */
  unlock(id: string, token: string): void {
    if (!this.row(id)) throw new Error(`unknown machine ${id}`);
    this.tokens.set(id, token);
  }

  token(id: string): string | null {
    return this.tokens.get(id) ?? null;
  }

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM machines WHERE id = ?`).get(id) as
      Row | undefined;
  }

  private toMachine(r: Row): PairedMachine {
    return {
      id: r.id,
      name: r.name,
      address: r.address,
      port: r.port,
      fingerprint: r.fingerprint,
      addedAt: r.added_at,
      unlocked: this.tokens.has(r.id),
    };
  }
}

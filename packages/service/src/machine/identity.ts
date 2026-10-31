import { randomUUID } from 'node:crypto';
import type { Db } from '../history/db.js';

const ID_KEY = 'machine:id';
const NAME_KEY = 'machine:name';

export type MachineIdentity = { id: string; name: string };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** This machine's id (made once, kept for good) and its name (the host name until renamed). */
export function loadMachineIdentity(db: Db, fallbackName: string): MachineIdentity {
  let id = text(db.getUiState(ID_KEY));
  if (!id) {
    id = randomUUID();
    db.setUiState(ID_KEY, id);
  }
  return { id, name: text(db.getUiState(NAME_KEY)) ?? fallbackName };
}

export function renameMachine(db: Db, name: string): MachineIdentity {
  const { id } = loadMachineIdentity(db, name);
  db.setUiState(NAME_KEY, name);
  return { id, name };
}

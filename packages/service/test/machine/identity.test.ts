import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { loadMachineIdentity, renameMachine } from '../../src/machine/identity.js';

const openTestDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-machine-')), 'db'));

describe('machine identity', () => {
  it('creates a machine id once and keeps it', () => {
    const db = openTestDb();
    const a = loadMachineIdentity(db, 'ubuntu-pc');
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.name).toBe('ubuntu-pc');
    expect(loadMachineIdentity(db, 'other').id).toBe(a.id);
  });

  it('renames the machine', () => {
    const db = openTestDb();
    loadMachineIdentity(db, 'ubuntu-pc');
    expect(renameMachine(db, 'Ubuntu PC').name).toBe('Ubuntu PC');
    expect(loadMachineIdentity(db, 'x').name).toBe('Ubuntu PC');
  });
});

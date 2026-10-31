import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { PairedMachines } from '../../src/machine/paired-machines.js';

const db = openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-paired-')), 'db')).raw;
const fresh = (): PairedMachines => {
  db.exec('DELETE FROM machines');
  return new PairedMachines(db);
};
const ubuntu = {
  id: 'm-1',
  name: 'Ubuntu PC',
  address: '192.168.1.20',
  port: 47380,
  certPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
  fingerprint: 'AB:CD',
  deviceId: 'd-1',
  addedAt: 1_000,
};

describe('paired machines', () => {
  it('stores machines in the order they were added, the certificate kept inside', () => {
    const m = fresh();
    m.add(ubuntu);
    m.add({ ...ubuntu, id: 'm-2', name: 'Mac', addedAt: 500 });
    expect(m.list().map((x) => x.id)).toEqual(['m-1', 'm-2']);
    expect(m.list()[0]).toEqual({
      id: 'm-1',
      name: 'Ubuntu PC',
      address: '192.168.1.20',
      port: 47380,
      fingerprint: 'AB:CD',
      addedAt: 1_000,
      unlocked: false,
    });
    expect(m.get('m-1')).toMatchObject({ certPem: ubuntu.certPem, deviceId: 'd-1' });
    expect(m.get('nope')).toBeNull();
  });

  it('keeps tokens in memory only', () => {
    const m = fresh();
    m.add(ubuntu);
    expect(m.token('m-1')).toBeNull();
    m.unlock('m-1', 'a'.repeat(64));
    expect(m.token('m-1')).toBe('a'.repeat(64));
    expect(m.list()[0]?.unlocked).toBe(true);
    expect(JSON.stringify(db.prepare('SELECT * FROM machines').all())).not.toContain(
      'a'.repeat(64),
    );
    // A new instance (a restart) starts locked.
    expect(new PairedMachines(db).token('m-1')).toBeNull();
    expect(() => m.unlock('nope', 'b'.repeat(64))).toThrow();
  });

  it('updates the name and the address but keeps the pin', () => {
    const m = fresh();
    m.add(ubuntu);
    expect(m.update('m-1', { name: 'Den', address: 'ubuntu-pc.local', port: 1234 })).toMatchObject({
      name: 'Den',
      address: 'ubuntu-pc.local',
      port: 1234,
      fingerprint: 'AB:CD',
    });
    expect(m.update('m-1', {})).toMatchObject({ name: 'Den' });
    expect(m.get('m-1')?.certPem).toBe(ubuntu.certPem);
    expect(() => m.update('nope', { name: 'x' })).toThrow();
  });

  it('removes a machine and forgets its token', () => {
    const m = fresh();
    m.add(ubuntu);
    m.unlock('m-1', 'a'.repeat(64));
    m.remove('m-1');
    expect(m.list()).toEqual([]);
    expect(m.token('m-1')).toBeNull();
    m.add(ubuntu);
    expect(m.token('m-1')).toBeNull();
  });
});

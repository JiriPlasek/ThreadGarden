import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PowerConfigSchema } from '@threadgarden/protocol';
import { PowerStore } from '../../src/power/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-power-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = PowerConfigSchema.parse({
  kind: 'tasmota-zigbee',
  address: '192.168.1.5',
  device: 'plug',
});

describe('PowerStore', () => {
  it('loads nothing before a save', () => {
    expect(new PowerStore(dir).load()).toBeNull();
  });

  it('writes 0600 and round-trips the configuration and password', async () => {
    const store = new PowerStore(dir);
    store.save(config, 's3cret');
    expect(store.load()).toEqual({ config, password: 's3cret' });
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'power-switch.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the stored password when saved again without one', () => {
    const store = new PowerStore(dir);
    store.save(config, 's3cret');
    store.save({ ...config, offWatts: 8 });
    expect(store.load()).toEqual({ config: { ...config, offWatts: 8 }, password: 's3cret' });
  });

  it('deletes the file on null', () => {
    const store = new PowerStore(dir);
    store.save(config, 's3cret');
    store.save(null);
    expect(existsSync(join(dir, 'power-switch.json'))).toBe(false);
    expect(store.load()).toBeNull();
    store.save(null); // nothing to delete is fine
  });

  it('writes atomically: no .tmp is left, and a leftover one does not break load', () => {
    const store = new PowerStore(dir);
    writeFileSync(join(dir, 'power-switch.json.tmp'), '{half');
    expect(store.load()).toBeNull();
    store.save(config, 'pw');
    expect(existsSync(join(dir, 'power-switch.json.tmp'))).toBe(false);
    writeFileSync(join(dir, 'power-switch.json.tmp'), '{half');
    expect(store.load()).toEqual({ config, password: 'pw' });
  });

  it('treats a corrupt file as not configured', () => {
    writeFileSync(join(dir, 'power-switch.json'), '{nope');
    expect(new PowerStore(dir).load()).toBeNull();
  });
});

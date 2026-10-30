import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceLock,
  readDiscovery,
  writeDiscovery,
  type Discovery,
} from '../src/discovery.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-disc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Discovery = {
  pid: 123,
  port: 4567,
  token: 'abc',
  version: '1.0.0',
  protocolVersion: 1,
  startedAt: 1000,
};

describe('discovery', () => {
  it('returns null when absent', async () => {
    expect(await readDiscovery(dir)).toBeNull();
  });
  it('writeDiscovery is atomic and readable back', async () => {
    await writeDiscovery(dir, sample);
    expect(await readDiscovery(dir)).toEqual(sample);
    expect(await readdir(dir)).toEqual(['service.json']);
  });
  it('returns null for corrupt json', async () => {
    await writeFile(join(dir, 'service.json'), '{nope');
    expect(await readDiscovery(dir)).toBeNull();
  });
});

describe('acquireInstanceLock', () => {
  it('second acquire returns null while first is held; succeeds after release', async () => {
    const first = await acquireInstanceLock(dir);
    expect(first).not.toBeNull();
    expect(await acquireInstanceLock(dir)).toBeNull();
    await first!.release();
    const again = await acquireInstanceLock(dir);
    expect(again).not.toBeNull();
    await again!.release();
  });
  it('succeeds after a stale pid', async () => {
    await writeFile(join(dir, 'service.lock'), '2147483646');
    const lock = await acquireInstanceLock(dir);
    expect(lock).not.toBeNull();
    await lock!.release();
  });
});

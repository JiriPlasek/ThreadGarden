import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-disc-'));
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
  it('carries the remote listener when there is one', async () => {
    const headless = { ...sample, remotePort: 47380, remoteAddresses: ['192.168.1.20'] };
    await writeDiscovery(dir, headless);
    expect(await readDiscovery(dir)).toEqual(headless);
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
  it('treats an empty lock file as held', async () => {
    await writeFile(join(dir, 'service.lock'), '');
    expect(await acquireInstanceLock(dir)).toBeNull();
    expect(await readFile(join(dir, 'service.lock'), 'utf8')).toBe('');
  });
  it('exactly one of many concurrent acquires wins', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireInstanceLock(dir)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    await results.find((r) => r !== null)!.release();
  });
  it('exactly one wins when racing over a stale lock', async () => {
    await writeFile(join(dir, 'service.lock'), '2147483646');
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireInstanceLock(dir)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    await results.find((r) => r !== null)!.release();
    expect(await readdir(dir)).toEqual([]);
  });
});

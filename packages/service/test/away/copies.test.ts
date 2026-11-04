import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSummary, CopyItem } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import { CopyStore } from '../../src/away/copies.js';
import { openDb } from '../../src/history/db.js';
import { DeviceRegistry } from '../../src/machine/devices.js';
import { PairedMachines } from '../../src/machine/paired-machines.js';
import { registerMachineHandlers } from '../../src/server/handlers/machines.js';
import { Router } from '../../src/server/router.js';

const db = openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-copies-')), 'db'));
const fresh = (): CopyStore => {
  db.raw.exec('DELETE FROM machine_copies; DELETE FROM chat_copies');
  return new CopyStore(db.raw, () => 5_000);
};

const summary = (n: number, lastActivity = n): ChatSummary =>
  ({
    sessionId: `s-${n}`,
    title: `Chat ${n}`,
    projectId: 'p-1',
    cwd: '/work',
    status: 'idle',
    preview: '',
    lastActivity,
    pinned: false,
    live: false,
    external: null,
    unread: false,
  }) as ChatSummary;

const lists = (chats: ChatSummary[]) => ({ machineId: 'm-1', info: null, projects: [], chats });

describe('the copy store', () => {
  it('saveLists keeps the 500 most recent and drops chat copies no longer listed', () => {
    const store = fresh();
    store.saveChat({ machineId: 'm-1', sessionId: 's-gone', summary: summary(0), items: [] });
    store.saveChat({ machineId: 'm-2', sessionId: 's-gone', summary: summary(0), items: [] });
    store.saveChat({ machineId: 'm-1', sessionId: 's-1', summary: summary(1), items: [] });
    const chats = Array.from({ length: 520 }, (_, i) => summary(i + 1));
    store.saveLists(lists(chats));
    const copy = store.get('m-1')!;
    expect(copy.chats).toHaveLength(500);
    // The most recent by lastActivity: 520 down to 21.
    expect(copy.chats[0]!.sessionId).toBe('s-520');
    expect(copy.chats.at(-1)!.sessionId).toBe('s-21');
    expect(copy.copiedAt).toBe(5_000);
    // s-1 fell off the 500, s-gone was never listed; another machine's copy stays.
    expect(store.chat('m-1', 's-1')).toBeNull();
    expect(store.chat('m-1', 's-gone')).toBeNull();
    expect(store.chat('m-2', 's-gone')).not.toBeNull();
  });

  it('saveChat keeps only the last 10 user, assistant and permission items', () => {
    const store = fresh();
    const user = (i: number): CopyItem => ({ kind: 'user', id: `u${i}`, text: `t${i}`, ts: i });
    const items = [
      ...Array.from({ length: 12 }, (_, i) => user(i)),
      { kind: 'thinking', id: 'th', text: 'hm' },
      { kind: 'system', id: 'sy', level: 'info', text: 'x' },
    ] as unknown as CopyItem[];
    store.saveChat({ machineId: 'm-1', sessionId: 's-1', summary: summary(1), items });
    const copy = store.chat('m-1', 's-1')!;
    expect(copy.items.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, i) => `u${i + 2}`));
    expect(copy.summary.sessionId).toBe('s-1');
    expect(copy.copiedAt).toBe(5_000);
  });

  it("tails reports each chat copy's lastActivity", () => {
    const store = fresh();
    store.saveChat({ machineId: 'm-1', sessionId: 's-1', summary: summary(1, 111), items: [] });
    store.saveChat({ machineId: 'm-1', sessionId: 's-2', summary: summary(2, 222), items: [] });
    store.saveChat({ machineId: 'm-2', sessionId: 's-3', summary: summary(3, 333), items: [] });
    expect(store.tails('m-1')).toEqual({ 's-1': 111, 's-2': 222 });
    expect(store.tails('nobody')).toEqual({});
  });

  it('forget drops the lists and chats of one machine', () => {
    const store = fresh();
    store.saveLists(lists([summary(1)]));
    store.saveChat({ machineId: 'm-1', sessionId: 's-1', summary: summary(1), items: [] });
    store.saveChat({ machineId: 'm-2', sessionId: 's-1', summary: summary(1), items: [] });
    store.forget('m-1');
    expect(store.get('m-1')).toBeNull();
    expect(store.chat('m-1', 's-1')).toBeNull();
    expect(store.chat('m-2', 's-1')).not.toBeNull();
  });

  it('removing a machine forgets its copy', async () => {
    const store = fresh();
    const paired = new PairedMachines(db.raw);
    db.raw.exec('DELETE FROM machines');
    paired.add({
      id: 'm-1',
      name: 'Ubuntu PC',
      address: '127.0.0.1',
      port: 1,
      certPem: 'pem',
      fingerprint: 'fp',
      deviceId: 'd-1',
      addedAt: 0,
    });
    store.saveLists(lists([summary(1)]));
    store.saveChat({ machineId: 'm-1', sessionId: 's-1', summary: summary(1), items: [] });
    const router = new Router();
    registerMachineHandlers(router, {
      db,
      devices: new DeviceRegistry(db.raw),
      identity: () => ({
        id: 'self',
        name: 'This PC',
        platform: 'linux',
        headless: false,
        home: '',
        capabilities: [],
      }),
      paired,
      copies: store,
    });
    await router.dispatch(
      { id: 1, method: 'machines.remove', params: { machineId: 'm-1', revoke: false } },
      { clientId: 'c', origin: 'local' },
    );
    expect(store.get('m-1')).toBeNull();
    expect(store.chat('m-1', 's-1')).toBeNull();
  });
});

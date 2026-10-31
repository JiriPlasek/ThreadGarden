import { describe, expect, it, vi } from 'vitest';
import { relayUrl } from '../../src/lib/state/machines.svelte';
import { samePlace, wirePlace } from '../../src/lib/state/places.svelte';
import { chatKey, LOCAL_FALLBACK_ID, parseChatKey } from '../../src/lib/state/refs';
import { TabsState } from '../../src/lib/state/tabs.svelte';
import {
  here,
  LOCAL,
  M1,
  pairedMachine,
  setup,
  setupTwoMachines,
  summary,
} from '../layout/harness';
import { FakeServer } from '../service/fake-ws';

const flush = () => new Promise((r) => setTimeout(r, 20));

const opened = (s: FakeServer): string[] =>
  s.calls('chat.open').map((c) => (c.params as { sessionId: string }).sessionId);

describe('chat references', () => {
  it('keys a chat by its machine and session id, and parses keys back', () => {
    expect(chatKey({ machineId: 'm', sessionId: 's' })).toBe('m/s');
    expect(parseChatKey('m/s')).toEqual({ machineId: 'm', sessionId: 's' });
    expect(parseChatKey('nope')).toBeNull();
    expect(parseChatKey('/s')).toBeNull();
    expect(parseChatKey('m/')).toBeNull();
  });

  it("builds a machine's relay URL on the local service", () => {
    expect(relayUrl(5555, 'abc')).toBe('ws://127.0.0.1:5555/relay?machine=abc');
  });
});

describe('machine scopes', () => {
  it("This PC's scope is the app's own stores", async () => {
    const { app, client } = await setup();
    const local = app.scopes.local();
    expect(local.machineId).toBe(LOCAL);
    expect(local.api).toBe(client);
    expect(local.chats).toBe(app.chats);
    expect(local.places).toBe(app.places);
    expect(local.sessions).toBe(app.sessions);
    expect(app.scopes.get(LOCAL)).toBe(local);
    expect(app.scopes.all()).toEqual([local]);
  });

  it('gives a paired machine a scope of its own, on its relay client', async () => {
    const { app, server } = await setupTwoMachines({
      configureRemote: (s) => {
        s.handlers['projects.list'] = () => [
          {
            projectId: 'r1',
            path: '/home/u/tg-cli',
            displayName: 'tg-cli',
            pinned: false,
            hidden: false,
            lastActivity: 1,
            counts: { needsYou: 0, running: 0 },
          },
        ];
      },
    });
    const m1 = app.scopes.get(M1)!;
    expect(m1.machineId).toBe(M1);
    expect(m1.api).toBe(app.machines.get(M1)!.client);
    expect(app.scopes.all().map((s) => s.machineId)).toEqual([LOCAL, M1]);
    await vi.waitFor(() =>
      expect(m1.places.projects.map((p) => p.displayName)).toEqual(['tg-cli']),
    );
    expect(app.places.projects).toEqual([]);
    expect(server.calls('machines.unlock')).toHaveLength(1);
  });

  it('keeps the same session id on two machines apart', async () => {
    const { app, server, remote } = await setupTwoMachines(); // both fake services return session 's1'
    app.tabs.openTab({ machineId: LOCAL, sessionId: 's1' });
    app.tabs.openTab({ machineId: M1, sessionId: 's1' });
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`, `${M1}/s1`]);
    expect(app.tabs.active).toBe(`${M1}/s1`);
    expect(app.scopes.get(M1)!.chats).not.toBe(app.scopes.local().chats);

    // Each machine opens its own chat, through its own service.
    await vi.waitFor(() => expect(opened(remote)).toEqual(['s1']));
    expect(opened(server)).toEqual(['s1']);
    expect(app.scopes.local().tabs.active).toBeNull();
    expect(app.scopes.get(M1)!.tabs.active).toBe('s1');

    // Closing This PC's tab leaves Ubuntu PC's chat alone.
    app.tabs.close(`${LOCAL}/s1`);
    expect(app.scopes.local().chats.get('s1')).toBeUndefined();
    expect(app.scopes.get(M1)!.chats.get('s1')).toBeDefined();
  });

  it("a machine's scope opens the restored tabs that were waiting for it", async () => {
    const { app, remote } = await setupTwoMachines({
      configure: (s) => {
        s.handlers['uiState.get'] = (p) =>
          (p as { key: string }).key === 'tabs'
            ? { value: { open: [`${M1}/s7`], active: `${M1}/s7` } }
            : { value: null };
      },
    });
    await app.tabs.restore();
    await vi.waitFor(() => expect(opened(remote)).toEqual(['s7']));
  });

  /** The layout names M1's chat `s7` (active) and `s8` (background). */
  const restoredOnM1 = (s: FakeServer): void => {
    s.handlers['uiState.get'] = (p) =>
      (p as { key: string }).key === 'tabs'
        ? { value: { open: [`${M1}/s7`, `${M1}/s8`], active: `${M1}/s7` } }
        : { value: null };
  };
  const summarised = (s: FakeServer): string[] =>
    s.calls('sessions.summaries').flatMap((c) => (c.params as { sessionIds: string[] }).sessionIds);

  it('restored tabs of a machine still connecting open once it is on', async () => {
    let unlock!: () => void;
    const { app, remote } = await setupTwoMachines({
      waitForOn: false,
      configure: (s) => {
        restoredOnM1(s);
        // M1's relay is not opened until the unlock answers.
        s.handlers['machines.unlock'] = () => new Promise((r) => (unlock = () => r({})));
      },
    });
    await vi.waitFor(() => expect(app.scopes.get(M1)).toBeDefined());
    await app.tabs.restore();
    await flush();
    expect(app.machines.get(M1)?.status).not.toBe('on');
    unlock();
    await vi.waitFor(() => expect(opened(remote)).toEqual(['s7']));
    const chat = app.scopes.get(M1)!.chats;
    await vi.waitFor(() => expect(chat.get('s7')?.loaded).toBe(true));
    expect(chat.get('s7')?.error).toBeNull();
    await vi.waitFor(() => expect(summarised(remote)).toContain('s8'));
  });

  it('restored tabs open when the machine is listed (and connects) after the restore', async () => {
    let list!: () => void;
    const { app, remote } = await setupTwoMachines({
      waitForOn: false,
      configure: (s) => {
        restoredOnM1(s);
        s.handlers['machines.list'] = () =>
          new Promise((r) => (list = () => r([pairedMachine(M1, 'Ubuntu PC')])));
      },
    });
    await app.tabs.restore();
    expect(app.scopes.get(M1)).toBeUndefined();
    list();
    await vi.waitFor(() => expect(opened(remote)).toEqual(['s7']));
    await vi.waitFor(() => expect(app.scopes.get(M1)!.chats.get('s7')?.loaded).toBe(true));
    expect(app.scopes.get(M1)!.chats.get('s7')?.error).toBeNull();
  });

  it('opens a restored chat once, not twice, when its machine reconnects', async () => {
    const { app, remote } = await setupTwoMachines({
      configure: restoredOnM1,
      configureRemote: (s) => {
        s.handlers['chat.since'] = () => ({ events: [], seq: 1 });
      },
    });
    await app.tabs.restore();
    await vi.waitFor(() => expect(opened(remote)).toEqual(['s7']));
    remote.drop(4502);
    await vi.waitFor(() => expect(app.machines.get(M1)?.status).toBe('on'), { timeout: 3000 });
    await flush();
    // The reconnect catches the loaded chat up; it is not opened again.
    expect(opened(remote)).toEqual(['s7']);
  });

  it('closes the tabs of machines missing from the first list, only once it arrived', async () => {
    let list!: () => void;
    const { app } = await setupTwoMachines({
      waitForOn: false,
      configure: (s) => {
        s.handlers['uiState.get'] = (p) =>
          (p as { key: string }).key === 'tabs'
            ? { value: { open: [`${M1}/a`, 'gone/b', 'c'], active: 'gone/b' } }
            : { value: null };
        s.handlers['machines.list'] = () =>
          new Promise((r) => (list = () => r([pairedMachine(M1, 'Ubuntu PC')])));
      },
    });
    await app.tabs.restore();
    await flush();
    // Not listed yet: nothing is known to be gone.
    expect(app.tabs.open).toEqual([`${M1}/a`, 'gone/b', here('c')]);
    list();
    await vi.waitFor(() => expect(app.tabs.open).toEqual([`${M1}/a`, here('c')]));
    expect(app.tabs.active).toBe(here('c'));
  });

  it('closes them too when the list arrived before the restore', async () => {
    const { app } = await setupTwoMachines({
      configure: (s) => {
        s.handlers['uiState.get'] = (p) =>
          (p as { key: string }).key === 'tabs'
            ? { value: { open: ['gone/b', `${M1}/a`], active: `${M1}/a` } }
            : { value: null };
      },
    });
    await app.tabs.restore();
    expect(app.tabs.open).toEqual([`${M1}/a`]);
    // Later tabs of a machine paired afterwards are not touched.
    app.tabs.openTab({ machineId: 'later', sessionId: 'x' });
    expect(app.tabs.open).toEqual([`${M1}/a`, 'later/x']);
  });

  it("maps stored tabs of the 'local' fallback to This PC's id", async () => {
    const { app } = await setup((s) => {
      s.handlers['uiState.get'] = () => ({ value: { open: ['local/a', 'b'], active: 'local/a' } });
    });
    await app.tabs.restore();
    expect(app.tabs.open).toEqual([here('a'), here('b')]);
    expect(app.tabs.active).toBe(here('a'));
  });

  it('migrates stored tabs without a machine id to This PC', async () => {
    const { app } = await setup((s) => {
      s.handlers['uiState.get'] = () => ({ value: { open: ['a', 'b'], active: 'b' } });
    });
    await app.tabs.restore();
    expect(app.tabs.open).toEqual([`${LOCAL}/a`, `${LOCAL}/b`]);
    expect(app.tabs.active).toBe(`${LOCAL}/b`);
  });

  it('keeps stored machine-qualified tabs as they are', async () => {
    const { app } = await setupTwoMachines({
      configure: (s) => {
        s.handlers['uiState.get'] = () => ({
          value: { open: [`${M1}/x`, 'a'], active: `${M1}/x` },
        });
      },
    });
    await app.tabs.restore();
    expect(app.tabs.open).toEqual([`${M1}/x`, `${LOCAL}/a`]);
    expect(app.tabs.active).toBe(`${M1}/x`);
  });

  it('stores the tabs as chat keys on the local service', async () => {
    const { app, server, remote } = await setupTwoMachines();
    app.tabs.openTab('a');
    app.tabs.openTab({ machineId: M1, sessionId: 'b' });
    const saved = server
      .calls('uiState.set')
      .filter((c) => (c.params as { key: string }).key === 'tabs');
    expect(saved.at(-1)?.params).toEqual({
      key: 'tabs',
      value: { open: [here('a'), `${M1}/b`], active: `${M1}/b` },
    });
    expect(remote.calls('uiState.set')).toEqual([]);
  });

  it('a bare session id means This PC', async () => {
    const { app } = await setup();
    app.tabs.openTab('s1');
    expect(app.tabs.open).toEqual([here('s1')]);
    app.tabs.activate('s1');
    app.tabs.close('s1');
    expect(app.tabs.open).toEqual([]);
  });

  it("without a machine in the local hello, This PC is '" + LOCAL_FALLBACK_ID + "'", async () => {
    const { app } = await setup((s) => {
      s.handlers.hello = () => ({ serviceVersion: '0.1.0', protocolVersion: 5 });
    });
    expect(app.scopes.local().machineId).toBe('local');
    app.tabs.openTab('a');
    expect(app.tabs.open).toEqual(['local/a']);
  });

  it('closes the tabs of a removed machine and drops its scope', async () => {
    const { app } = await setupTwoMachines();
    app.tabs.openTab({ machineId: LOCAL, sessionId: 's1' });
    app.tabs.openTab({ machineId: M1, sessionId: 's1' });
    app.tabs.openTab({ machineId: M1, sessionId: 's2' });
    await app.machines.remove(M1);
    expect(app.tabs.open).toEqual([`${LOCAL}/s1`]);
    expect(app.tabs.active).toBe(`${LOCAL}/s1`);
    expect(app.scopes.get(M1)).toBeUndefined();
    expect(app.scopes.all()).toHaveLength(1);
  });

  it('a project place names its machine; the service never sees it', async () => {
    const a = { kind: 'project', projectId: 'p1', machineId: LOCAL } as const;
    const b = { kind: 'project', projectId: 'p1', machineId: M1 } as const;
    expect(samePlace(a, b)).toBe(false);
    expect(samePlace(a, { ...a, include: ['onHold'] })).toBe(true);
    expect(wirePlace(b)).toEqual({ kind: 'project', projectId: 'p1' });
    // No machine named means This PC.
    const bare = { kind: 'project', projectId: 'p1' } as const;
    expect(samePlace(bare, a, LOCAL)).toBe(true);
    expect(samePlace(bare, b, LOCAL)).toBe(false);
    expect(samePlace(bare, { kind: 'project', projectId: 'p1', machineId: 'local' })).toBe(true);

    const { app, server } = await setup((s) => {
      s.handlers['sessions.list'] = () => ({ items: [summary('s1')] });
    });
    app.places.select(b);
    app.places.setInclude(true);
    expect(app.places.selected).toEqual({ ...b, include: ['onHold', 'archived'] });
    await vi.waitFor(() =>
      expect(server.calls('sessions.list').at(-1)?.params).toMatchObject({
        place: { kind: 'project', projectId: 'p1', include: ['onHold', 'archived'] },
      }),
    );
    // Selecting This PC's p1 without naming the machine is the same place as naming it.
    app.places.select({ kind: 'project', projectId: 'p1', machineId: LOCAL });
    const before = app.places.selected;
    app.places.select(bare);
    expect(app.places.selected).toBe(before);
    for (const c of server.calls('sessions.list')) {
      expect((c.params as { place: object }).place).not.toHaveProperty('machineId');
    }
  });
});

describe('tabs of one machine', () => {
  it('lists that machine’s session ids and opens tabs on it', () => {
    const tabs = new TabsState();
    tabs.init(null as never, { localMachineId: () => 'L' });
    const m = tabs.on(() => 'M');
    tabs.openTab('a');
    m.openTab('b');
    expect(tabs.open).toEqual(['L/a', 'M/b']);
    expect(m.open).toEqual(['b']);
    expect(m.active).toBe('b');
    expect(tabs.on(() => 'L').active).toBeNull();
    expect(tabs.on(() => 'L').open).toEqual(['a']);
  });
});

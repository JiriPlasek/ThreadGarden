import type { ChatItem, ChatSummary } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { ChatsState } from '../../src/lib/state/chats.svelte';
import { ConnectionState } from '../../src/lib/state/connection.svelte';
import { PlacesState } from '../../src/lib/state/places.svelte';
import { SessionsState } from '../../src/lib/state/sessions.svelte';
import { COLUMNS_SAVE_DELAY_MS, SettingsState } from '../../src/lib/state/settings.svelte';
import { TabsState } from '../../src/lib/state/tabs.svelte';
import { FakeServer } from '../service/fake-ws';

const summary = (sessionId: string): ChatSummary => ({
  sessionId,
  title: sessionId,
  projectId: 'p',
  cwd: '/w',
  status: 'idle',
  preview: '',
  lastActivity: 0,
  pinned: false,
  live: true,
  external: null,
  unread: false,
  bucket: 'active',
  backFromHold: false,
});
const text = (id: string, markdown: string, streaming = false): ChatItem => ({
  kind: 'assistantText',
  id,
  markdown,
  streaming,
});

let server: FakeServer;
let client: ServiceClient;
const flushAsync = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  client = new ServiceClient({ WebSocketImpl: server.Impl });
  const p = client.connect('ws://x:1', 't');
  await flushAsync();
  await p;
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe('chats', () => {
  const setup = () => {
    const frames: (() => void)[] = [];
    const chats = new ChatsState();
    chats.init(client, { schedule: (cb) => frames.push(cb) });
    server.handlers['chat.open'] = (p) => ({
      summary: summary((p as { sessionId: string }).sessionId),
      header: { model: 'm' },
      items: [text('a', 'start')],
      hasMore: true,
      seq: 10,
    });
    return { chats, frames, runFrame: () => frames.splice(0).forEach((f) => f()) };
  };

  it('chats batches streaming updates per frame', async () => {
    const { chats, frames, runFrame } = setup();
    await chats.open('s1');
    for (let i = 1; i <= 50; i++) {
      server.push('chat.items', {
        sessionId: 's1',
        seq: 10 + i,
        items: [text('b', 'x'.repeat(i), true)],
      });
    }
    server.push('chat.items', { sessionId: 's1', seq: 61, items: [text('c', 'new')] });
    const chat = chats.get('s1')!;
    // Nothing applied yet, exactly one frame requested for 51 events.
    expect(chat.items.map((i) => i.id)).toEqual(['a']);
    expect(frames).toHaveLength(1);
    const before = chat.items;
    runFrame();
    expect(chat.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect((chat.items[1] as { markdown: string }).markdown).toHaveLength(50);
    expect(chat.items).not.toBe(before);
    expect(chat.seq).toBe(61);
  });

  it('upserts replaced items in place and keeps order', async () => {
    const { chats, runFrame } = setup();
    await chats.open('s1');
    server.push('chat.items', {
      sessionId: 's1',
      seq: 11,
      items: [text('b', '1', true), text('c', 'c')],
    });
    runFrame();
    server.push('chat.items', {
      sessionId: 's1',
      seq: 12,
      items: [text('b', 'final')],
      replace: true,
    });
    runFrame();
    expect(chats.get('s1')!.items.map((i) => (i as { markdown: string }).markdown)).toEqual([
      'start',
      'final',
      'c',
    ]);
  });

  it('ignores events at or below the current seq', async () => {
    const { chats, frames } = setup();
    await chats.open('s1');
    server.push('chat.items', { sessionId: 's1', seq: 10, items: [text('z', 'dup')] });
    expect(frames).toHaveLength(0);
    expect(chats.get('s1')!.items.map((i) => i.id)).toEqual(['a']);
  });

  it('applies status events immediately and merges header', async () => {
    const { chats } = setup();
    await chats.open('s1');
    server.push('chat.status', {
      sessionId: 's1',
      seq: 11,
      status: 'needsYou',
      waitingFor: 'permission',
      header: { effort: 'high' },
    });
    const chat = chats.get('s1')!;
    expect(chat.status).toBe('needsYou');
    expect(chat.waitingFor).toBe('permission');
    expect(chat.header).toEqual({ model: 'm', effort: 'high' });
  });

  it('keeps events that arrive while chat.open is in flight', async () => {
    const { chats, runFrame } = setup();
    server.silent.add('chat.open');
    const opening = chats.open('s1');
    await flushAsync();
    server.push('chat.items', { sessionId: 's1', seq: 9, items: [text('old', 'old')] }); // below snapshot
    server.push('chat.items', { sessionId: 's1', seq: 11, items: [text('late', 'late')] });
    server.live!.deliver({
      id: server.calls('chat.open')[0]!.id,
      result: {
        summary: summary('s1'),
        header: {},
        items: [text('a', 'a')],
        hasMore: false,
        seq: 10,
      },
    });
    await opening;
    runFrame();
    expect(chats.get('s1')!.items.map((i) => i.id)).toEqual(['a', 'late']);
    expect(chats.get('s1')!.seq).toBe(11);
  });

  it('sync opens missing chats as they are activated and drops closed ones', async () => {
    const { chats } = setup();
    server.handlers['sessions.summaries'] = () => ({ items: [] });
    chats.sync(['s1', 's2'], 's1');
    chats.sync(['s1', 's2'], 's2');
    await flushAsync();
    expect([...chats.byId.keys()].sort()).toEqual(['s1', 's2']);
    chats.sync(['s2'], 's2');
    expect([...chats.byId.keys()]).toEqual(['s2']);
    server.push('chat.items', { sessionId: 's1', seq: 99, items: [text('x', 'x')] });
    expect(chats.get('s1')).toBeUndefined();
  });

  it('restored tabs: only the active chat is opened; the others load when activated', async () => {
    const { chats } = setup();
    server.handlers['sessions.summaries'] = (p) => ({
      items: (p as { sessionIds: string[] }).sessionIds.map((id) => ({
        ...summary(id),
        title: `Title ${id}`,
        status: 'working',
      })),
    });
    chats.sync(['s1', 's2', 's3'], 's2');
    await flushAsync();
    expect(
      server.calls('chat.open').map((c) => (c.params as { sessionId: string }).sessionId),
    ).toEqual(['s2']);
    // Background tabs still show a title and status, from one light summaries request.
    expect(server.calls('sessions.summaries').map((c) => c.params)).toEqual([
      { sessionIds: ['s1', 's3'] },
    ]);
    expect(chats.summaryOf('s1')).toMatchObject({ title: 'Title s1', status: 'working' });
    // Their status follows events without loading them.
    server.push('chat.status', { sessionId: 's3', seq: 5, status: 'needsYou', waitingFor: 'Bash' });
    expect(chats.summaryOf('s3')).toMatchObject({ status: 'needsYou', waitingFor: 'Bash' });
    expect(chats.get('s3')).toBeUndefined();

    chats.sync(['s1', 's2', 's3'], 's3');
    await flushAsync();
    expect(
      server.calls('chat.open').map((c) => (c.params as { sessionId: string }).sessionId),
    ).toEqual(['s2', 's3']);
    // A chat that was shown stays resident (switching back is instant).
    expect([...chats.byId.keys()].sort()).toEqual(['s2', 's3']);
    expect(server.calls('sessions.summaries')).toHaveLength(1);
  });

  it('derives pending permission requests', async () => {
    const { chats, runFrame } = setup();
    await chats.open('s1');
    const req = (id: string, state: 'pending' | 'allowed'): ChatItem => ({
      kind: 'permissionRequest',
      id,
      requestId: id,
      toolName: 'Bash',
      input: {},
      suggestions: [],
      state,
      variant: 'tool',
    });
    server.push('chat.items', {
      sessionId: 's1',
      seq: 11,
      items: [req('r1', 'pending'), req('r2', 'allowed')],
    });
    runFrame();
    expect(chats.get('s1')!.pendingRequests.map((r) => r.id)).toEqual(['r1']);
  });

  it('loadOlder prepends without duplicates', async () => {
    const { chats } = setup();
    await chats.open('s1');
    server.handlers['chat.older'] = () => ({
      items: [text('o1', 'o1'), text('a', 'a')],
      hasMore: false,
    });
    await chats.loadOlder('s1');
    expect(chats.get('s1')!.items.map((i) => i.id)).toEqual(['o1', 'a']);
    expect(chats.get('s1')!.hasMore).toBe(false);
  });
});

describe('tabs', () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    server.handlers['uiState.get'] = (p) => ({
      value: store.get((p as { key: string }).key) ?? null,
    });
    server.handlers['uiState.set'] = (p) => {
      const { key, value } = p as { key: string; value: unknown };
      store.set(key, value);
      return {};
    };
  });

  it('tabs persist and restore', async () => {
    const a = new TabsState();
    a.init(client);
    a.openTab('s1');
    a.openTab('s2');
    a.openTab('s3');
    a.move('s3', 0);
    a.activate('s2');
    a.close('s1');
    await flushAsync();
    expect(store.get('tabs')).toEqual({ open: ['s3', 's2'], active: 's2' });

    const b = new TabsState();
    b.init(client);
    const seen: string[][] = [];
    b.subscribe(() => seen.push([...b.open]));
    await b.restore();
    expect(b.open).toEqual(['s3', 's2']);
    expect(b.active).toBe('s2');
    expect(b.restored).toBe(true);
    expect(seen).toEqual([['s3', 's2']]);
  });

  it('closing the active tab activates a neighbour', () => {
    const t = new TabsState();
    t.init(client);
    ['a', 'b', 'c'].forEach(t.openTab);
    t.activate('b');
    t.close('b');
    expect(t.active).toBe('c');
    t.close('c');
    expect(t.active).toBe('a');
    t.close('a');
    expect(t.active).toBeNull();
  });

  it('restore tolerates empty or malformed state', async () => {
    store.set('tabs', { open: ['x', 5, 'x'], active: 'gone' });
    const t = new TabsState();
    t.init(client);
    await t.restore();
    expect(t.open).toEqual(['x']);
    expect(t.active).toBe('x');
  });

  it('column widths persist through uiState, debounced', async () => {
    const s = new SettingsState();
    s.init(client);
    s.setColumnWidth('places', 200);
    s.setColumnWidth('places', 211.4);
    await flushAsync();
    expect(s.columnWidths).toEqual({ places: 211 });
    expect(store.has('columns')).toBe(false);
    await vi.advanceTimersByTimeAsync(COLUMNS_SAVE_DELAY_MS);
    expect(store.get('columns')).toEqual({ places: 211 });
    expect(
      server.calls('uiState.set').filter((c) => (c.params as { key: string }).key === 'columns'),
    ).toHaveLength(1);
    s.setCollapsed('list', true);
    await flushAsync();
    const s2 = new SettingsState();
    s2.init(client);
    await s2.restoreColumns();
    expect(s2.columnWidths).toEqual({ places: 211 });
    expect(s2.collapsed).toEqual({ list: true });
  });
});

describe('places and sessions', () => {
  it('places refreshes counts on change events, coalescing bursts', async () => {
    let n = 0;
    server.handlers['places.counts'] = () => ({ needsYou: ++n, running: 0, all: 9 });
    server.handlers['projects.list'] = () => [];
    const places = new PlacesState();
    places.init(client);
    await flushAsync();
    expect(places.counts.needsYou).toBe(1);
    for (let i = 0; i < 5; i++) server.push('sessions.changed', { sessionIds: ['s'] });
    await flushAsync();
    await flushAsync();
    expect(server.calls('places.counts').length).toBeLessThanOrEqual(3);
    expect(places.counts.needsYou).toBe(server.calls('places.counts').length);
  });

  it('sessions list follows the selected place, query and paging', async () => {
    server.handlers['places.counts'] = () => ({ needsYou: 0, running: 0, all: 0 });
    server.handlers['projects.list'] = () => [];
    server.handlers['sessions.list'] = (p) => {
      const q = p as { cursor?: string; query?: string; place: { kind: string } };
      if (q.cursor) return { items: [summary('s3')] };
      return {
        items: [summary(`${q.place.kind}-${q.query ?? ''}-1`), summary('s2')],
        nextCursor: 'c1',
      };
    };
    const places = new PlacesState();
    const sessions = new SessionsState();
    places.init(client);
    sessions.init(client, places);
    await flushAsync();
    // v1.2 §3: Active is the first place (it replaced All chats).
    expect(sessions.items.map((s) => s.sessionId)).toEqual(['active--1', 's2']);
    places.select({ kind: 'running' });
    await flushAsync();
    expect(sessions.items[0]?.sessionId).toBe('running--1');
    await sessions.setQuery('foo');
    expect(sessions.items[0]?.sessionId).toBe('running-foo-1');
    await sessions.loadMore();
    expect(sessions.items.map((s) => s.sessionId)).toEqual(['running-foo-1', 's2', 's3']);
    expect(sessions.nextCursor).toBeUndefined();
    server.push('chat.status', { sessionId: 's2', seq: 1, status: 'working' });
    expect(sessions.items[1]?.status).toBe('working');
  });
});

describe('connection', () => {
  it('tracks status, version drift and indexing progress', async () => {
    const c = new ConnectionState();
    c.init(client, { serviceVersion: '0.0.9', appVersion: '0.1.0' });
    expect(c.status).toBe('open');
    expect(c.restartNeeded).toBe(true);
    server.push('index.progress', { done: 1, total: 4 });
    expect(c.indexing).toEqual({ done: 1, total: 4 });
    server.push('index.progress', { done: 4, total: 4 });
    expect(c.indexing).toBeNull();
    server.drop();
    expect(c.status).toBe('reconnecting');
    expect(c.offline).toBe(true);
  });
});

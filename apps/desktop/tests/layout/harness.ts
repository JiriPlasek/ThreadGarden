import {
  PROTOCOL_VERSION,
  type ChatStatus,
  type ChatSummary,
  type MachineInfo,
  type PairedMachine,
  type Project,
} from '@threadgarden/protocol';
import { expect, vi } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { AgentsState } from '../../src/lib/state/agents.svelte';
import { AnalyticsState } from '../../src/lib/state/analytics.svelte';
import { BucketsState } from '../../src/lib/state/buckets.svelte';
import { ChatsState } from '../../src/lib/state/chats.svelte';
import { ConnectionState } from '../../src/lib/state/connection.svelte';
import { InteractionState } from '../../src/lib/state/interaction.svelte';
import { LifecycleState } from '../../src/lib/state/lifecycle.svelte';
import { APP_CONTEXT, type AppState } from '../../src/lib/state/context';
import { MachinesState } from '../../src/lib/state/machines.svelte';
import { PlacesState } from '../../src/lib/state/places.svelte';
import { machineIdOf } from '../../src/lib/state/refs';
import { ScheduledState } from '../../src/lib/state/scheduled.svelte';
import { createScope, makeScope, Scopes, wireScope } from '../../src/lib/state/scope';
import { SessionsState } from '../../src/lib/state/sessions.svelte';
import { SettingsState } from '../../src/lib/state/settings.svelte';
import { TabsState } from '../../src/lib/state/tabs.svelte';
import { UsageStore } from '../../src/lib/state/usage.svelte';
import { YourTurnState } from '../../src/lib/state/your-turn.svelte';
import { FakeServer, routedImpl } from '../service/fake-ws';

/** This PC's machine id, as the harness's local fake service says in `hello`. */
export const LOCAL = 'this-pc-id';
/** The paired machine ("Ubuntu PC") of `setupTwoMachines`. */
export const M1 = 'machine-1';

/** The tab key of `sessionId` on This PC. */
export const here = (sessionId: string): string => `${LOCAL}/${sessionId}`;

export const summary = (
  sessionId: string,
  over: Partial<ChatSummary> & { status?: ChatStatus } = {},
): ChatSummary => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectId: 'p1',
  cwd: '/work/alpha',
  status: 'history',
  preview: `preview of ${sessionId}`,
  lastActivity: Date.now() - 60_000,
  pinned: false,
  live: false,
  external: null,
  unread: false,
  bucket: 'active',
  backFromHold: false,
  ...over,
});

export const project = (projectId: string, displayName: string, over: Partial<Project> = {}) => ({
  projectId,
  path: `/work/${displayName}`,
  displayName,
  pinned: false,
  hidden: false,
  lastActivity: Date.now(),
  counts: { needsYou: 0, running: 0 },
  ...over,
});

export const machineInfo = (id: string, name: string): MachineInfo => ({
  id,
  name,
  platform: 'linux',
  headless: id !== LOCAL,
  home: '/home/u',
  capabilities: ['remote'],
});

export const pairedMachine = (id: string, name: string): PairedMachine => ({
  id,
  name,
  address: '192.168.1.5',
  port: 47380,
  fingerprint: 'aa',
  addedAt: 1,
  unlocked: false,
});

/** What every fake service of the harness answers (a test's `configure` adds to it). */
const serve = (server: FakeServer, machine: MachineInfo): void => {
  Object.assign(server.handlers, {
    hello: () => ({ serviceVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION, machine }),
    'places.counts': () => ({
      needsYou: 0,
      running: 0,
      all: 0,
      active: 0,
      onHold: 0,
      archived: 0,
    }),
    'projects.list': () => [],
    'sessions.list': () => ({ items: [] }),
    'uiState.get': () => ({ value: null }),
    'uiState.set': () => ({}),
    'system.status': () => ({
      claude: { found: true, path: '/usr/bin/claude', version: '2.1.314' },
      externalAvailable: true,
      indexing: { done: 0, total: 0 },
    }),
    'drafts.get': () => ({ text: '' }),
    'drafts.set': () => ({}),
    'chat.open': (p: unknown) => ({
      summary: summary((p as { sessionId: string }).sessionId),
      header: {},
      items: [],
      hasMore: false,
      seq: 1,
    }),
    'machines.list': () => [],
    'machines.unlock': () => ({}),
    'machines.remove': () => ({ revoked: true }),
  });
};

/** Device tokens in memory instead of the OS keychain. */
const memoryTokens = (stored: Record<string, string>) => {
  const store = new Map(Object.entries(stored));
  return {
    get: async (id: string): Promise<string | null> => store.get(id) ?? null,
    set: async (id: string, token: string): Promise<void> => void store.set(id, token),
    clear: async (id: string): Promise<void> => void store.delete(id),
  };
};

/**
 * Fresh state modules wired to `client` the way `app.ts` wires the singletons:
 * This PC's scope is made of the app's own stores; every paired machine gets a
 * scope of its own, on a relay client built with `impl`.
 */
const wire = (
  client: ServiceClient,
  impl: typeof WebSocket,
  tokens: Record<string, string>,
): AppState => {
  const tabs = new TabsState();
  const settings = new SettingsState();
  const local = makeScope(() => machineIdOf(client.hello), client, tabs, {
    places: new PlacesState(),
    sessions: new SessionsState(),
    chats: new ChatsState(),
    buckets: new BucketsState(),
    scheduled: new ScheduledState(),
    interaction: new InteractionState(),
    // Started like the app's; a test that needs another debounce re-inits it (init stops it first).
    yourTurn: new YourTurnState(),
  });
  const scopes = new Scopes(local);
  const app: AppState = {
    connection: new ConnectionState(),
    places: local.places,
    sessions: local.sessions,
    tabs,
    chats: local.chats,
    settings,
    agents: new AgentsState(),
    interaction: local.interaction,
    lifecycle: new LifecycleState(),
    buckets: local.buckets,
    usage: new UsageStore(),
    scheduled: local.scheduled,
    analytics: new AnalyticsState(),
    machines: new MachinesState(),
    scopes,
  };
  const chatOptions = { schedule: (cb: () => void) => cb() };
  // The same order as `app.ts`'s `wire()`.
  app.connection.init(client);
  wireScope(local, { tabs, settings, agents: app.agents, chats: chatOptions, scopes });
  app.tabs.init(client, { localMachineId: () => local.machineId });
  app.settings.init(client);
  app.agents.init(client, { machineId: () => local.machineId });
  // "Restart service" reconnects to whatever the (fake) service connection reports.
  app.lifecycle.init(client, app.agents, app.connection, async (conn) => {
    app.connection.setVersions(conn);
    await client.connect(`ws://fake:${conn.port}`, conn.token);
  });
  app.usage.init(client);
  app.analytics.init(client);
  app.places.follow(scopes);
  app.agents.follow(scopes);
  scopes.follow(app.machines, tabs, (m) =>
    createScope(m.id, m.client, { tabs, settings, agents: app.agents, chats: chatOptions }),
  );
  app.machines.init(client, client, {
    relayUrl: (id) => `ws://fake:1/relay?machine=${id}`,
    localToken: () => 't',
    tokens: memoryTokens(tokens),
    makeClient: (o) => new ServiceClient({ ...o, WebSocketImpl: impl }),
  });
  return app;
};

/** A connected fake service plus a fresh, wired set of state modules. */
export const setup = async (configure?: (server: FakeServer) => void) => {
  const server = new FakeServer();
  serve(server, machineInfo(LOCAL, 'my-host'));
  configure?.(server);
  const client = new ServiceClient({ WebSocketImpl: server.Impl });
  await client.connect('ws://fake:1', 't');
  const app = wire(client, server.Impl, {});
  const context = new Map<unknown, unknown>([[APP_CONTEXT, app]]);
  return { server, client, app, context };
};

/**
 * `setup` plus a paired machine `M1` ("Ubuntu PC") whose fake service sits
 * behind the local relay (its device token is in the fake keychain);
 * resolves once M1 is on unless `waitForOn` is false.
 */
export const setupTwoMachines = async (
  o: {
    configure?: (server: FakeServer) => void;
    configureRemote?: (server: FakeServer) => void;
    /** Resolve once M1 is on (default); false: as soon as the app is wired. */
    waitForOn?: boolean;
  } = {},
) => {
  const server = new FakeServer();
  const remote = new FakeServer();
  serve(server, machineInfo(LOCAL, 'my-host'));
  serve(remote, machineInfo(M1, 'ubuntu-pc'));
  server.handlers['machines.list'] = () => [pairedMachine(M1, 'Ubuntu PC')];
  o.configure?.(server);
  o.configureRemote?.(remote);
  const impl = routedImpl((url) => (url.includes('/relay?machine=') ? remote : server));
  const client = new ServiceClient({ WebSocketImpl: impl });
  await client.connect('ws://fake:1', 't');
  const app = wire(client, impl, { [M1]: 'device-token' });
  if (o.waitForOn !== false)
    await vi.waitFor(() => expect(app.machines.get(M1)?.status).toBe('on'));
  const context = new Map<unknown, unknown>([[APP_CONTEXT, app]]);
  return { server, remote, client, app, context };
};

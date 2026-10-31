import type { ChatStatus, ChatSummary, Project } from '@pahub/protocol';
import { ServiceClient } from '../../src/lib/service/client';
import { AgentsState } from '../../src/lib/state/agents.svelte';
import { AnalyticsState } from '../../src/lib/state/analytics.svelte';
import { BucketsState } from '../../src/lib/state/buckets.svelte';
import { ChatsState } from '../../src/lib/state/chats.svelte';
import { ConnectionState } from '../../src/lib/state/connection.svelte';
import { InteractionState } from '../../src/lib/state/interaction.svelte';
import { LifecycleState } from '../../src/lib/state/lifecycle.svelte';
import { APP_CONTEXT, type AppState } from '../../src/lib/state/context';
import { PlacesState } from '../../src/lib/state/places.svelte';
import { ScheduledState } from '../../src/lib/state/scheduled.svelte';
import { SessionsState } from '../../src/lib/state/sessions.svelte';
import { SettingsState } from '../../src/lib/state/settings.svelte';
import { TabsState } from '../../src/lib/state/tabs.svelte';
import { UsageStore } from '../../src/lib/state/usage.svelte';
import { FakeServer } from '../service/fake-ws';

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

/** A connected fake service plus a fresh, wired set of state modules. */
export const setup = async (configure?: (server: FakeServer) => void) => {
  const server = new FakeServer();
  Object.assign(server.handlers, {
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
  });
  configure?.(server);
  const client = new ServiceClient({ WebSocketImpl: server.Impl });
  await client.connect('ws://fake:1', 't');

  const app: AppState = {
    connection: new ConnectionState(),
    places: new PlacesState(),
    sessions: new SessionsState(),
    tabs: new TabsState(),
    chats: new ChatsState(),
    settings: new SettingsState(),
    agents: new AgentsState(),
    interaction: new InteractionState(),
    lifecycle: new LifecycleState(),
    buckets: new BucketsState(),
    usage: new UsageStore(),
    scheduled: new ScheduledState(),
    analytics: new AnalyticsState(),
  };
  app.connection.init(client);
  app.places.init(client);
  app.sessions.init(client, app.places);
  app.chats.init(client, { schedule: (cb) => cb() });
  app.tabs.init(client);
  app.settings.init(client);
  app.agents.init(client);
  app.interaction.init(client);
  // "Restart service" reconnects to whatever the (fake) service connection reports.
  app.lifecycle.init(client, app.agents, app.connection, async (conn) => {
    app.connection.setVersions(conn);
    await client.connect(`ws://fake:${conn.port}`, conn.token);
  });
  app.buckets.init(client, app.chats);
  app.usage.init(client);
  app.scheduled.init(client);
  app.analytics.init(client);
  app.tabs.subscribe(() => app.chats.sync(app.tabs.open, app.tabs.active));

  const context = new Map<unknown, unknown>([[APP_CONTEXT, app]]);
  return { server, client, app, context };
};

/**
 * Wires the service client to every state module. The UI calls `startApp` once;
 * tests build their own instances and call `init` with a fake client instead.
 */
import { serviceConnection, updater, type ServiceConnection } from '../native';
import { startAttention } from '../notifications';
import { agents } from './agents.svelte';
import { analytics } from './analytics.svelte';
import { connection } from './connection.svelte';
import { lifecycle } from './lifecycle.svelte';
import { machines, relayUrl } from './machines.svelte';
import { places } from './places.svelte';
import { client, createScope, scopes, wireScope } from './scope';
import { settings } from './settings.svelte';
import { tabs } from './tabs.svelte';
import { updates } from './updates.svelte';
import { usage } from './usage.svelte';

export { client, scopes };

/** This PC's scope: the app's singletons, so a single-machine user runs what always ran. */
const localScope = scopes.local();

/** The local service now (its port and token change when it restarts). */
let current: ServiceConnection | null = null;

let started: Promise<void> | null = null;
let wired = false;
let loaded = false;

/**
 * Idempotent while it succeeds or is in progress: later calls return the same
 * promise. A failed start is forgotten, so "Retry" (or any later call) tries again.
 */
export const startApp = (): Promise<void> =>
  (started ??= run().catch((err: unknown) => {
    started = null;
    throw err;
  }));

/** Registers every state module with the client, once, before the first connection. */
const wire = (): void => {
  if (wired) return;
  wired = true;
  connection.init(client);
  // This PC's places, sessions, chats, buckets, scheduled sends and "Your turn".
  wireScope(localScope, { tabs, agents, scopes });
  tabs.init(client, { localMachineId: () => localScope.machineId });
  settings.init(client);
  agents.init(client, { machineId: () => localScope.machineId });
  lifecycle.init(client, agents, connection, connectTo);
  usage.init(client);
  analytics.init(client);
  // Notifications: a watcher per machine (the scopes below), one tray badge (the sum).
  startAttention({ scopes, machines, settings, tabs, places });
  // Paired machines: a scope each, on its relay client through the local service.
  // Needs you, Running, the bucket counts and the agents strip add up every machine's.
  places.follow(scopes);
  agents.follow(scopes);
  scopes.follow(machines, tabs, (m) => createScope(m.id, m.client, { tabs, agents }));
  machines.init(client, client, {
    relayUrl: (id) => relayUrl(current?.port ?? 0, id),
    localToken: () => current?.token ?? '',
  });
};

/**
 * Connects (or, after "Restart service", reconnects) the client to `conn`. The
 * first successful connection also loads the persisted settings and layout;
 * later ones resync through the modules' `onOpen` / `onReconnect` hooks.
 */
const connectTo = async (conn: ServiceConnection): Promise<void> => {
  connection.setVersions(conn);
  current = conn;
  await client.connect(`ws://127.0.0.1:${conn.port}`, conn.token);
  if (loaded) return;
  await Promise.all([
    settings.load(),
    settings.restoreColumns(),
    settings.restoreScale(),
    settings.restoreActivity(),
    places.restoreMissingOpen(),
    machines.restoreCollapsed(),
    machines.restoreMissingOpen(),
    tabs.restore(),
  ]);
  loaded = true;
  // Self-update: checks GitHub shortly after start, then every 6 hours.
  updates.init({
    api: client,
    updater,
    appVersion: conn.appVersion,
    stopLocalService: lifecycle.stopLocalService,
  });
};

const run = async (): Promise<void> => {
  // Wired first, so "Restart service" works even when no service could be used.
  wire();
  await connectTo(await serviceConnection());
};

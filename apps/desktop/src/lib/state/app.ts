/**
 * Wires the service client to every state module. The UI calls `startApp` once;
 * tests build their own instances and call `init` with a fake client instead.
 */
import { serviceConnection, type ServiceConnection } from '../native';
import { startAttention } from '../notifications';
import { ServiceClient } from '../service/client';
import { agents } from './agents.svelte';
import { chats } from './chats.svelte';
import { connection } from './connection.svelte';
import { interaction } from './interaction.svelte';
import { lifecycle } from './lifecycle.svelte';
import { places } from './places.svelte';
import { sessions } from './sessions.svelte';
import { settings } from './settings.svelte';
import { tabs } from './tabs.svelte';

export const client = new ServiceClient();

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
  places.init(client);
  sessions.init(client, places);
  chats.init(client);
  tabs.init(client);
  settings.init(client);
  agents.init(client);
  interaction.init(client);
  lifecycle.init(client, agents, connection, connectTo);
  tabs.subscribe(() => chats.sync(tabs.open, tabs.active));
  startAttention({ api: client, settings, tabs, places });
};

/**
 * Connects (or, after "Restart service", reconnects) the client to `conn`. The
 * first successful connection also loads the persisted settings and layout;
 * later ones resync through the modules' `onOpen` / `onReconnect` hooks.
 */
const connectTo = async (conn: ServiceConnection): Promise<void> => {
  connection.setVersions(conn);
  await client.connect(`ws://127.0.0.1:${conn.port}`, conn.token);
  if (loaded) return;
  await Promise.all([
    settings.load(),
    settings.restoreColumns(),
    settings.restoreScale(),
    settings.restoreActivity(),
    tabs.restore(),
  ]);
  loaded = true;
};

const run = async (): Promise<void> => {
  // Wired first, so "Restart service" works even when no service could be used.
  wire();
  await connectTo(await serviceConnection());
};

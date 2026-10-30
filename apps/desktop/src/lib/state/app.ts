/**
 * Wires the service client to every state module. The UI calls `startApp` once;
 * tests build their own instances and call `init` with a fake client instead.
 */
import { serviceConnection } from '../native';
import { ServiceClient } from '../service/client';
import { chats } from './chats.svelte';
import { connection } from './connection.svelte';
import { places } from './places.svelte';
import { sessions } from './sessions.svelte';
import { settings } from './settings.svelte';
import { tabs } from './tabs.svelte';

export const client = new ServiceClient();

export const startApp = async (): Promise<void> => {
  const conn = await serviceConnection();
  connection.init(client, conn);
  places.init(client);
  sessions.init(client, places);
  chats.init(client);
  tabs.init(client);
  settings.init(client);
  tabs.subscribe(() => chats.sync(tabs.open));
  await client.connect(`ws://127.0.0.1:${conn.port}`, conn.token);
  await Promise.all([settings.load(), settings.restoreColumns(), tabs.restore()]);
};

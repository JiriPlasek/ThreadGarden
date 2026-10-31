/**
 * The state modules a component reads. Components call `useApp()`; the app uses the
 * module singletons, tests pass their own wired instances through Svelte context.
 */
import { getContext } from 'svelte';
import { agents, type AgentsState } from './agents.svelte';
import { analytics, type AnalyticsState } from './analytics.svelte';
import { buckets, type BucketsState } from './buckets.svelte';
import { chats, type ChatsState } from './chats.svelte';
import { connection, type ConnectionState } from './connection.svelte';
import { interaction, type InteractionState } from './interaction.svelte';
import { lifecycle, type LifecycleState } from './lifecycle.svelte';
import { places, type PlacesState } from './places.svelte';
import { sessions, type SessionsState } from './sessions.svelte';
import { settings, type SettingsState } from './settings.svelte';
import { tabs, type TabsState } from './tabs.svelte';

export type AppState = {
  connection: ConnectionState;
  places: PlacesState;
  sessions: SessionsState;
  tabs: TabsState;
  chats: ChatsState;
  settings: SettingsState;
  agents: AgentsState;
  interaction: InteractionState;
  lifecycle: LifecycleState;
  buckets: BucketsState;
  /** v1.3: the Analytics view. */
  analytics: AnalyticsState;
};

export const APP_CONTEXT = Symbol('pahub.app');

const singletons: AppState = {
  connection,
  places,
  sessions,
  tabs,
  chats,
  settings,
  agents,
  interaction,
  lifecycle,
  buckets,
  analytics,
};

/** Must be called during component initialisation. */
export const useApp = (): AppState => getContext<AppState | undefined>(APP_CONTEXT) ?? singletons;

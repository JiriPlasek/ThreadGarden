/**
 * The state modules a component reads. Components call `useApp()`; the app uses the
 * module singletons, tests pass their own wired instances through Svelte context.
 */
import { getContext } from 'svelte';
import { agents, type AgentsState } from './agents.svelte';
import { analytics, type AnalyticsState } from './analytics.svelte';
import { away, type AwayState } from './away.svelte';
import { buckets, type BucketsState } from './buckets.svelte';
import { chats, type ChatsState } from './chats.svelte';
import { connection, type ConnectionState } from './connection.svelte';
import { interaction, type InteractionState } from './interaction.svelte';
import { lifecycle, type LifecycleState } from './lifecycle.svelte';
import { machineUpdates, type MachineUpdatesState } from './machine-updates.svelte';
import { machines, type MachinesState } from './machines.svelte';
import { places, type PlacesState } from './places.svelte';
import { power, type PowerState } from './power.svelte';
import { scheduled, type ScheduledState } from './scheduled.svelte';
import { scopes, type MachineScope, type Scopes } from './scope';
import { sessions, type SessionsState } from './sessions.svelte';
import { settings, type SettingsState } from './settings.svelte';
import { tabs, type TabsState } from './tabs.svelte';
import { updates, type UpdatesState } from './updates.svelte';
import { usageAccounts, type UsageAccounts } from './usage-accounts.svelte';
import { usage, type UsageStore } from './usage.svelte';

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
  /** v1.3 B: This PC's plan usage (its scope's `usage`). */
  usage: UsageStore;
  /** Every machine's usage grouped by account, and the Usage dialog's state. */
  usageAccounts: UsageAccounts;
  scheduled: ScheduledState;
  /** v1.3: the Analytics view. */
  analytics: AnalyticsState;
  /** Self-update from GitHub Releases. */
  updates: UpdatesState;
  /** Remote machines: This PC plus the paired ones. */
  machines: MachinesState;
  /** Updating paired machines: the latest release, who is behind it, each update's stage and outcome. */
  machineUpdates: MachineUpdatesState;
  /** Power control of paired machines: plug readings, power status, Off / Starting… / Shutting down. */
  power: PowerState;
  /** Messages written for machines that are away, waiting on this device. */
  away: AwayState;
  /**
   * One scope of per-machine stores per machine. The keys above (`places`,
   * `sessions`, `chats`, …) are This PC's scope.
   */
  scopes: Pick<Scopes, 'get' | 'all' | 'local' | 'observe'>;
};

export const APP_CONTEXT = Symbol('threadgarden.app');

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
  usage,
  usageAccounts,
  scheduled,
  analytics,
  updates,
  machines,
  machineUpdates,
  power,
  away,
  scopes,
};

/** Must be called during component initialisation. */
export const useApp = (): AppState => getContext<AppState | undefined>(APP_CONTEXT) ?? singletons;

/**
 * The machine scope of what is around a component: a chat, and the new-chat
 * dialog's composer, are shown inside their machine's scope.
 */
export const SCOPE_CONTEXT = Symbol('threadgarden.scope');

/**
 * The per-machine stores (`chats`, `buckets`, `scheduled`, `interaction`,
 * `places`, …) of the machine the component is shown for; This PC's outside
 * any machine scope. Must be called during component initialisation.
 */
export const useScope = (): MachineScope =>
  getContext<MachineScope | undefined>(SCOPE_CONTEXT) ?? useApp().scopes.local();

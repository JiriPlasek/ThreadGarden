import { quitApp, serviceConnection, stopService, type ServiceConnection } from '../native';
import type { AgentsState } from './agents.svelte';
import type { Api } from './api';
import type { ConnectionState } from './connection.svelte';
import type { MachineChat } from './merged-list.svelte';

/** The confirmations of spec §4.2: Stop all work, Quit Threadgarden completely, Restart service. */
export type ServiceAction = 'stopAll' | 'quitAll' | 'restart';

/** "A and B", "A, B and C". */
const andList = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The "Stop all work" confirmation's text: it stops every connected machine's
 * work, named when there is more than one (`machines`: the names of those on).
 */
export const stopAllDescription = (machines: readonly string[]): string =>
  `Every chat running in Threadgarden${machines.length > 1 ? ` on ${andList(machines)}` : ''} is interrupted and closed, with its background agents and processes. Sessions running in a terminal are not affected, and any chat can be resumed later.`;

/** Points the client at a freshly found service and loads what the UI needs. */
export type Reconnect = (conn: ServiceConnection) => Promise<void>;

/**
 * The app and service lifecycle (spec §4.2) behind confirmations: stopping
 * all work, quitting Threadgarden completely (service included), and restarting an
 * older or incompatible service (ruling R18). `dialog` is the open confirmation.
 */
export class LifecycleState {
  dialog = $state<ServiceAction | null>(null);

  private api: Api | null = null;
  private agents: AgentsState | null = null;
  private connection: ConnectionState | null = null;
  private reconnect: Reconnect = async () => {};

  init = (
    api: Api,
    agents: AgentsState,
    connection: ConnectionState,
    reconnect: Reconnect,
  ): void => {
    this.api = api;
    this.agents = agents;
    this.connection = connection;
    this.reconnect = reconnect;
  };

  /**
   * This PC's own live chats: what quitting completely and restarting the
   * service stop (terminal sessions and other machines are not affected).
   */
  get running(): MachineChat[] {
    return this.agents?.local.filter((a) => a.live && !a.external) ?? [];
  }

  /** Every connected machine's own live chats: what "Stop all work" stops. */
  get runningEverywhere(): MachineChat[] {
    return this.agents?.items.filter((a) => a.live && !a.external) ?? [];
  }

  /** True when the service can answer requests (not down, not another protocol). */
  private get reachable(): boolean {
    return this.connection?.status === 'open' && this.api?.status === 'open';
  }

  stopAll = async (): Promise<void> => {
    await this.agents?.stopAll();
  };

  /** Stops all work, then the service, then exits the app. */
  quitCompletely = async (): Promise<void> => {
    if (this.reachable) await this.api!.request('service.shutdown', { stopAll: true });
    else await stopService();
    await quitApp();
  };

  /**
   * "Restart service": the service stops all its work and exits (asked over the
   * socket when it speaks our protocol, by the shell otherwise, which also waits
   * for the process to end), then the shell finds or starts the app's own
   * version and the client reconnects to it.
   */
  restartService = async (): Promise<void> => {
    if (this.reachable) await this.api!.request('service.shutdown', { stopAll: true });
    await stopService();
    await this.reconnect(await serviceConnection());
  };
}

export const lifecycle = new LifecycleState();

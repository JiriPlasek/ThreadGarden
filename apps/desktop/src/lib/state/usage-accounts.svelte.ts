/**
 * Usage per account (usage-per-account design §4): every machine scope's
 * usage, grouped into account entries for the bottom bar's chips and the
 * Usage dialog, plus the dialog's own state. A machine whose service never
 * answered and that has no kept copy is not listed.
 */
import { usageEmpty } from '@threadgarden/protocol';
import { groupUsage, type UsageEntry, type UsageMachine } from '../usage/accounts';
import { quietly } from './api';
import { machineNameOf, machines } from './machines.svelte';
import { scopes, type Scopes } from './scope';

export class UsageAccounts {
  /** The Usage dialog is open. */
  dialogOpen = $state(false);
  /** Fresh readings are on their way (the dialog shows it). */
  refreshing = $state(false);

  private readonly scopes: Pick<Scopes, 'all'>;
  private readonly names: (machineId: string) => string;

  constructor(scopes: Pick<Scopes, 'all'>, names: (machineId: string) => string) {
    this.scopes = scopes;
    this.names = names;
  }

  /** The account entries, This PC's first, then in the order of the machines. */
  entries = $derived.by((): UsageEntry[] => {
    const list: UsageMachine[] = [];
    for (const { machineId, usage } of this.scopes.all()) {
      if (!usage.connected && usage.value === usageEmpty) continue;
      list.push({
        machineId,
        name: this.names(machineId),
        state: usage.value,
        connected: usage.connected,
      });
    }
    return groupUsage(list);
  });

  /**
   * The chips' clock: the latest `now` of every machine's store. Each store
   * moves on at its own next reset, so any machine's window lapses on time.
   */
  now = $derived.by((): number => Math.max(...this.scopes.all().map((s) => s.usage.now)));

  /** Opens the Usage dialog, asking running chats for fresh readings. */
  open = (): void => {
    this.dialogOpen = true;
    quietly(this.refresh());
  };

  /** Asks every connected machine for a fresh reading (one that fails keeps its last). */
  refresh = async (): Promise<void> => {
    this.refreshing = true;
    try {
      await Promise.allSettled(
        this.scopes
          .all()
          .filter((s) => s.usage.connected)
          .map((s) => s.usage.refresh()),
      );
    } finally {
      this.refreshing = false;
    }
  };
}

/** The app's: every machine scope, named as the UI names machines. */
export const usageAccounts = new UsageAccounts(scopes, (id) => machineNameOf(machines, id));

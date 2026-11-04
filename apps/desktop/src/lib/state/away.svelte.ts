/**
 * Machines that are away (away machine spec): the messages waiting on this
 * device for them, as the local service lists them (`away.list`, then every
 * `away.changed`), and what each machine's copy says of it.
 */
import type {
  AwayItem,
  AwayState as AwayMachine,
  MachineCopy,
  MachineInfo,
} from '@threadgarden/protocol';
import type { Api } from './api';
import type { ChatRef } from './refs';

type AwayList = { items: AwayItem[]; states: AwayMachine[] };

/**
 * Whether a chat's later messages wait behind these rows of it (ruling R17),
 * even once its machine is connected, so none overtakes one still to go:
 * a row waiting, going out, or whose start gave up (it goes again once the
 * machine is up), and a new chat's first message whatever its state (the
 * machine doesn't have the chat). Only a refused message, which waits for
 * Retry, lets them pass.
 */
export const holdsBack = (items: AwayItem[]): boolean =>
  items.some((i) => i.kind === 'create' || !(i.state === 'failed' && i.reason === 'refused'));

export class AwayState {
  private list = $state.raw<AwayItem[]>([]);
  private machines = $state.raw<AwayMachine[]>([]);
  private api: Pick<Api, 'request'> | null = null;

  /** Follows the local service's list; returns a function that stops. */
  init = (api: Api): (() => void) => {
    this.api = api;
    const offs = [api.on('away.changed', this.apply), api.onOpen(this.load)];
    if (api.status === 'open') void this.load();
    return () => {
      for (const off of offs) off();
    };
  };

  private load = async (): Promise<void> => {
    try {
      this.apply(await this.api!.request('away.list', {}));
    } catch {
      // The next open, or the next change, brings it.
    }
  };

  private apply = (l: AwayList): void => {
    this.list = l.items;
    this.machines = l.states;
  };

  /** The messages waiting for one chat, in the order they go out. */
  items = (ref: ChatRef): AwayItem[] =>
    this.list.filter((i) => i.machineId === ref.machineId && i.sessionId === ref.sessionId);

  /** This device is turning the machine on for its waiting messages. */
  starting = (machineId: string): boolean =>
    this.machines.some((s) => s.machineId === machineId && s.starting);

  /** Takes back a message that has not gone out. */
  cancel = async (id: string): Promise<void> => {
    await this.api?.request('away.cancel', { id });
  };

  /** Tries the machine's failed messages again (and turns it on if it reads off). */
  retry = async (machineId: string): Promise<void> => {
    await this.api?.request('away.retry', { machineId });
  };
}

export const away = new AwayState();

/**
 * What a paired machine's scope last read of its copy: whether there is one,
 * when it was made ("last seen") and the machine's info then.
 */
export class CopyState {
  copiedAt = $state<number | null>(null);
  info = $state.raw<MachineInfo | null>(null);

  get has(): boolean {
    return this.copiedAt !== null;
  }

  seen = (copy: MachineCopy | null): void => {
    this.copiedAt = copy?.copiedAt ?? null;
    this.info = copy?.info ?? null;
  };
}

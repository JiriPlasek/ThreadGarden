/**
 * The Claude account of each machine (Settings → Claude accounts) and its
 * sign-in (protocol 14), keyed by the machine's id as `machines` knows it.
 * A machine is followed once asked: its `claude.account` events keep its row
 * current from then on.
 *
 * The sign-in link and the pasted code only pass through here: they are never
 * stored, logged or put into an error.
 */
import type { ClaudeAccount, UsageAccount } from '@threadgarden/protocol';
import type { ServiceClient } from '../service/client';
import { quietly } from './api';
import { machines, type MachinesState } from './machines.svelte';

type Link = Pick<ServiceClient, 'request' | 'on'>;

export class ClaudeAccounts {
  private states = $state<Record<string, ClaudeAccount>>({});
  /** The clients whose `claude.account` events are followed (a new client is followed anew). */
  private followed = new WeakSet<Link>();

  constructor(private readonly machines: Pick<MachinesState, 'get'>) {}

  /** What machine `id` last said (undefined: not asked yet). */
  get = (id: string): ClaudeAccount | undefined => this.states[id];

  /** Machine `id`'s client, followed from now on. */
  private link = (id: string): Link => {
    const entry = this.machines.get(id);
    if (!entry) throw new Error('That machine is not paired any more.');
    const client = entry.client;
    if (!this.followed.has(client)) {
      this.followed.add(client);
      // This PC's id can change once its service says it: the entry knows the current one.
      client.on('claude.account', (s) => {
        this.states[entry.id] = s;
      });
    }
    return client;
  };

  refresh = async (id: string): Promise<void> => {
    const s = await this.link(id).request('claude.account', {});
    this.states[id] = s;
  };

  /** Starts a sign-in (on chat `sessionId`'s process when given); answers the link to open. */
  signIn = async (id: string, sessionId?: string): Promise<string> => {
    const { url } = await this.link(id).request('claude.signIn', sessionId ? { sessionId } : {});
    return url;
  };

  /** Hands the pasted code to the sign-in; a refused code ends that sign-in and rejects. */
  submit = async (id: string, code: string): Promise<UsageAccount | null> => {
    const { account } = await this.link(id).request('claude.signInCode', { code });
    quietly(this.refresh(id));
    return account;
  };

  cancel = async (id: string): Promise<void> => {
    await this.link(id).request('claude.signInCancel', {});
  };
}

export const claudeAccounts = new ClaudeAccounts(machines);

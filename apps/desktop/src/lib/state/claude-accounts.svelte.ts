/**
 * Signing a machine in to Claude and out of it (protocol 14), keyed by the
 * machine's id as `machines` knows it: the sign-in dialog (`/login`, a failed
 * turn's Sign in to Claude) and `/logout`, both from a Claude chat.
 *
 * The sign-in link and the pasted code only pass through here: they are never
 * stored, logged or put into an error.
 */
import type { UsageAccount } from '@threadgarden/protocol';
import type { ServiceClient } from '../service/client';
import { machines, type MachinesState } from './machines.svelte';

type Link = Pick<ServiceClient, 'request'>;

export class ClaudeAccounts {
  constructor(private readonly machines: Pick<MachinesState, 'get'>) {}

  /** Machine `id`'s client. */
  private link = (id: string): Link => {
    const entry = this.machines.get(id);
    if (!entry) throw new Error('That machine is not paired any more.');
    return entry.client;
  };

  /** Starts a sign-in (on chat `sessionId`'s process when given); answers the link to open. */
  signIn = async (id: string, sessionId?: string): Promise<string> => {
    const { url } = await this.link(id).request('claude.signIn', sessionId ? { sessionId } : {});
    return url;
  };

  /** Hands the pasted code to the sign-in; a refused code ends that sign-in and rejects. */
  submit = async (id: string, code: string): Promise<UsageAccount | null> => {
    const { account } = await this.link(id).request('claude.signInCode', { code });
    return account;
  };

  cancel = async (id: string): Promise<void> => {
    await this.link(id).request('claude.signInCancel', {});
  };

  /** Signs machine `id` out (`claude auth logout` there); rejects with the machine's words. */
  signOut = async (id: string): Promise<void> => {
    await this.link(id).request('claude.signOut', {});
  };
}

export const claudeAccounts = new ClaudeAccounts(machines);

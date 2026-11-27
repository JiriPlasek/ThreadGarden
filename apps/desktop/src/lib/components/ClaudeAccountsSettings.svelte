<script lang="ts">
  import type { ClaudeAccount } from '@threadgarden/protocol';
  import ClaudeSignInDialog from '#lib/components/ClaudeSignInDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { isPhone } from '#lib/native.js';
  import { supportsClaudeLogin } from '#lib/projects.js';
  import { quietly } from '#lib/state/api.js';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel, type MachineEntry } from '#lib/state/machines.svelte.js';

  /**
   * Settings → Claude accounts: the Claude account each machine's chats last
   * reported, with Sign in or Switch account (protocol 14). A machine is asked
   * when it is on; it never starts Claude just to answer. The phone's own
   * entry runs no Claude, so the phone lists the paired machines only. A
   * machine without `claude-login` says to update it, and offers nothing.
   */
  const { machines, claudeAccounts } = useApp();

  const listed = $derived(machines.list.filter((m) => !(isPhone && m.local)));

  type Row = { text: string; action: 'Sign in' | 'Switch account' | null };

  const capital = (t: string): string => `${t[0]!.toUpperCase()}${t.slice(1)}`;

  const rowOf = (s: ClaudeAccount | undefined): Row => {
    if (s?.expired) return { text: 'Sign-in expired', action: 'Sign in' };
    const a = s?.account;
    if (!a) return { text: 'Not known yet', action: 'Sign in' };
    if (a.kind === 'apiKey') return { text: 'Uses an API key', action: null };
    if (a.kind === 'provider')
      return { text: `Uses ${a.provider ?? 'a cloud provider'}`, action: null };
    const text = a.email ? (a.plan ? `${a.email} · ${capital(a.plan)}` : a.email) : 'Signed in';
    return { text, action: 'Switch account' };
  };

  /** Each machine's link status when last looked at: one that comes on is asked (again). */
  const seen = new Map<string, string>();
  $effect(() => {
    for (const m of listed) {
      const before = seen.get(m.id);
      seen.set(m.id, m.status);
      if (m.status !== 'on' || before === 'on' || !supportsClaudeLogin(m)) continue;
      // A machine that can't say now keeps what it said last (or Not known yet).
      quietly(claudeAccounts.refresh(m.id));
    }
  });

  let target = $state<{ id: string; name: string } | null>(null);
  let dialogOpen = $state(false);

  const signIn = (m: MachineEntry): void => {
    target = { id: m.id, name: machineLabel(m) };
    dialogOpen = true;
  };
</script>

<!-- A phone with no machine paired yet has no account to show. -->
{#if listed.length > 0}
  <section class="grid gap-2 border-t pt-3" aria-labelledby="settings-claude-accounts">
    <h3 id="settings-claude-accounts" class="text-muted-foreground text-xs font-medium">
      Claude accounts
    </h3>
    {#each listed as m (m.id)}
      {@const name = machineLabel(m)}
      {@const row = rowOf(claudeAccounts.get(m.id))}
      {@const can = supportsClaudeLogin(m)}
      <div
        class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm"
        role="group"
        aria-label="Claude account on {name}"
      >
        <span class="max-w-40 min-w-0 shrink-0 truncate font-medium">{name}</span>
        {#if m.info && !can}
          <span class="text-muted-foreground min-w-0 flex-1 text-xs"
            >Update this machine to sign in from here.</span
          >
        {:else}
          <span class="min-w-0 flex-1 break-words">{row.text}</span>
          {#if can && row.action}
            <Button
              variant="outline"
              size="sm"
              disabled={m.status !== 'on'}
              onclick={() => signIn(m)}>{row.action}</Button
            >
          {/if}
        {/if}
      </div>
    {/each}
  </section>
{/if}

{#if target}
  <ClaudeSignInDialog bind:open={dialogOpen} machineId={target.id} machineName={target.name} />
{/if}

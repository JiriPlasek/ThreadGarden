<script lang="ts" module>
  import type { Unpushed } from '@threadgarden/protocol';

  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

  /** The last segment of a repo's path (either separator). */
  export const repoName = (repo: string): string =>
    repo
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || repo;

  /** One unpushed item as a sentence (spec §10). */
  export const describeUnpushed = (u: Unpushed): string => {
    const name = repoName(u.repo);
    switch (u.kind) {
      case 'uncommitted':
        return u.branch === null && u.reason === 'stashed changes'
          ? `${name}: ${plural(u.count, 'stashed change', 'stashed changes')}`
          : `${name}: ${plural(u.count, 'uncommitted change', 'uncommitted changes')}`;
      case 'unpushed':
        return `${name} ${u.branch ?? '(detached HEAD)'}: ${plural(u.count, 'commit', 'commits')} not on GitHub`;
      case 'unchecked':
        return `${name}: couldn't check (${u.reason ?? 'unknown reason'})`;
    }
  };
</script>

<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import { useApp } from '#lib/state/context.js';
  import { machineNameOf } from '#lib/state/machines.svelte.js';

  /**
   * "Unpushed work on ‹machine›" (remote machines plan 4, Task 15): the
   * machine's idle shutdown found work that never reached GitHub and paused.
   * It lists what it found; "Ask Claude to push it" (per repo with a chat)
   * sends that chat a message, and "Shut down anyway" shuts the machine down
   * regardless. The notice stays until the machine leaves `blocked` (its
   * service restarts the idle clock and says so), never hidden optimistically.
   */
  let { machineId }: { machineId: string } = $props();

  const { power, machines, scopes } = useApp();

  const name = $derived(machineNameOf(machines, machineId));
  const items = $derived(power.machine(machineId)?.unpushed ?? []);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const ask = async (u: Unpushed): Promise<void> => {
    const scope = scopes.get(machineId);
    if (!scope || u.sessionId === null) return;
    busy = true;
    failure = null;
    try {
      await scope.chats.send(
        u.sessionId,
        `Please commit and push your work in ${repoName(u.repo)} so the machine can shut down.`,
      );
    } catch (e) {
      failure = e instanceof Error && e.message ? e.message : 'The message could not be sent.';
    } finally {
      busy = false;
    }
  };

  const shutDown = async (): Promise<void> => {
    busy = true;
    failure = null;
    try {
      await power.shutDown(machineId, true);
      failure = power.error(machineId);
    } finally {
      busy = false;
    }
  };
</script>

<section
  class="mx-2 mb-2 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
  aria-labelledby="unpushed-{machineId}"
>
  <h3 id="unpushed-{machineId}" class="font-semibold">Unpushed work on {name}</h3>
  <p class="text-muted-foreground mt-0.5">Shutdown is paused until this is on GitHub.</p>
  <ul class="mt-1.5 space-y-1">
    {#each items as u, i (i)}
      <li class="flex items-center gap-1.5">
        <span class="min-w-0 flex-1 break-words" title={u.repo}>{describeUnpushed(u)}</span>
        {#if u.sessionId !== null}
          <Button variant="outline" size="xs" disabled={busy} onclick={() => ask(u)}
            >Ask Claude to push it</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
  <div class="mt-2 flex items-center gap-2">
    <Button variant="outline" size="xs" disabled={busy} onclick={shutDown}>Shut down anyway</Button>
    {#if failure}
      <span class="text-destructive" role="alert">{failure}</span>
    {/if}
  </div>
</section>

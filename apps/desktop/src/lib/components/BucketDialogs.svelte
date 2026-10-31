<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import MachineBucketDialogs from '#lib/components/MachineBucketDialogs.svelte';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel } from '#lib/state/machines.svelte.js';
  import type { MachineScope } from '#lib/state/scope.js';

  /**
   * The dialogs of moving chats between buckets (v1.2 §3), hosted once by the
   * app shell for the chat list, the chat header and the quick switcher: the
   * hold popover, "End this chat and archive it?" and the archive-older
   * confirmation of every machine (a row of another machine moves through
   * that machine), and the notices (toasts) for what a service skipped. With
   * more than one machine, a notice names its machine.
   */
  const { scopes, machines } = useApp();

  const all = $derived(scopes.all());
  const nameOf = (scope: MachineScope): string => {
    const m = machines.get(scope.machineId);
    return m ? machineLabel(m) : scope.machineId;
  };
</script>

{#each all as scope (scope)}
  <MachineBucketDialogs buckets={scope.buckets} chats={scope.chats} />
{/each}

<!-- Always in the DOM, so screen readers announce what appears in it. -->
<div
  role="status"
  class="pointer-events-none fixed inset-x-0 bottom-12 z-50 flex flex-col items-center gap-2 px-4"
>
  {#each all as scope (scope)}
    {@const notice = scope.buckets.notice}
    {#if notice}
      <div
        class="bg-popover text-popover-foreground ring-foreground/10 pointer-events-auto flex max-w-lg items-start gap-2 rounded-md px-3 py-2 text-sm shadow-md ring-1"
      >
        <p class="min-w-0 flex-1">{all.length > 1 ? `${nameOf(scope)}: ${notice}` : notice}</p>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground -mr-1 shrink-0 rounded p-0.5"
          aria-label="Dismiss"
          onclick={() => scope.buckets.dismissNotice()}
        >
          <XIcon class="size-4" aria-hidden="true" />
        </button>
      </div>
    {/if}
  {/each}
</div>

<script lang="ts">
  import HistoryIcon from '@lucide/svelte/icons/history';
  import XIcon from '@lucide/svelte/icons/x';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { useApp } from '#lib/state/context.js';
  import { machineNameOf } from '#lib/state/machines.svelte.js';
  import { parseChatKey } from '#lib/state/refs.js';
  import { cn } from '#lib/utils.js';
  import { chatTitle } from './chat-title';

  /**
   * The phone's tabs: the chats opened lately (the desktop's open tabs, most
   * recent first), to switch between them or let one go. Switching keeps the
   * chat level, so Back still returns to the list.
   */
  const { tabs, scopes, machines } = useApp();

  let open = $state(false);

  const titleOf = (key: string): string => chatTitle(scopes, key);

  /** Most recent first: tabs open at the end. */
  const recent = $derived([...tabs.open].reverse());

  const choose = (key: string): void => {
    tabs.activate(key);
    open = false;
  };
</script>

<button
  type="button"
  class="hover:bg-accent text-muted-foreground flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-sm"
  aria-label="Recent chats ({tabs.open.length})"
  disabled={tabs.open.length < 2}
  onclick={() => (open = true)}
>
  <HistoryIcon class="size-5" aria-hidden="true" />
  <span class="tabular-nums">{tabs.open.length}</span>
</button>

<Dialog.Root bind:open>
  <!-- One column that never grows past the dialog: a long title truncates, Close stays on screen. -->
  <Dialog.Content class="grid-cols-[minmax(0,1fr)] gap-2 p-3">
    <Dialog.Header>
      <Dialog.Title class="text-base">Recent chats</Dialog.Title>
      <Dialog.Description class="sr-only">Switch to a chat you opened lately</Dialog.Description>
    </Dialog.Header>
    <ul class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" aria-label="Recent chats">
      {#each recent as key (key)}
        {@const ref = parseChatKey(key)}
        <li class="flex min-w-0 items-center gap-1">
          <button
            type="button"
            class={cn(
              'hover:bg-accent flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-md px-2 text-left',
              key === tabs.active && 'bg-accent font-medium',
            )}
            aria-current={key === tabs.active ? 'true' : undefined}
            onclick={() => choose(key)}
          >
            <span class="w-full truncate text-sm">{titleOf(key)}</span>
            {#if ref && machines.several}
              <span class="text-muted-foreground text-xs"
                >{machineNameOf(machines, ref.machineId)}</span
              >
            {/if}
          </button>
          <button
            type="button"
            class="hover:bg-accent text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-md"
            aria-label="Close {titleOf(key)}"
            onclick={() => tabs.close(key)}
          >
            <XIcon class="size-4" aria-hidden="true" />
          </button>
        </li>
      {/each}
    </ul>
  </Dialog.Content>
</Dialog.Root>

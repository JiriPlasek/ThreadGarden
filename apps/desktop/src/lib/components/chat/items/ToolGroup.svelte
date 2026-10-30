<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { baseName } from '../../layout/chat-info';
  import type { ToolCallItem } from '../rows';
  import { groupLabel, summarize } from '../tools';
  import ItemBoundary from './ItemBoundary.svelte';
  import ToolCallRow from './ToolCallRow.svelte';
  import ToolStatus from './ToolStatus.svelte';

  /** A run of same-tool lookups as one row ("Read 12 files"); every call stays expandable. */
  let { name, items }: { name: string; items: ToolCallItem[] } = $props();

  let open = $state(false);
  const status = $derived(
    items.some((i) => i.status === 'running')
      ? 'running'
      : items.some((i) => i.status === 'error')
        ? 'error'
        : 'ok',
  );
  const targets = $derived(
    items
      .map((i) => {
        const t = summarize(i).target;
        return name === 'Read' ? baseName(t) : t;
      })
      .filter(Boolean)
      .join(', '),
  );
</script>

<div class="text-xs">
  <button
    type="button"
    class="hover:bg-muted/60 flex w-full max-w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <ChevronRightIcon
      class="text-muted-foreground size-4 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
      aria-hidden="true"
    />
    <ToolStatus {status} />
    <span class="shrink-0 font-medium">{groupLabel(name, items.length)}</span>
    {#if !open}
      <span class="text-muted-foreground min-w-0 truncate font-mono">{targets}</span>
    {/if}
  </button>
  {#if open}
    <div class="mt-0.5 flex flex-col pl-5.5">
      {#each items as it (it.id)}
        <ItemBoundary item={it}>
          <ToolCallRow item={it} />
        </ItemBoundary>
      {/each}
    </div>
  {/if}
</div>

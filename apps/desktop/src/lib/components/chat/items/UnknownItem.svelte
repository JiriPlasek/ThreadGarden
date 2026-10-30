<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { prettyJson } from '../tools';

  /**
   * Data pahub does not recognise (spec §6.4, anti-goal 3): never dropped, shown
   * collapsed with its raw JSON. A run of them is one row (R12); expanding it
   * shows every item's raw JSON.
   */
  let { items }: { items: { id: string; sdkType: string; raw: unknown }[] } = $props();

  let open = $state(false);
  const types = $derived([...new Set(items.map((i) => i.sdkType))]);
  const label = $derived(
    items.length === 1
      ? `Unrecognised item: ${items[0]!.sdkType}`
      : `${items.length} unrecognised items`,
  );
</script>

<div class="text-muted-foreground text-xs">
  <button
    type="button"
    class="hover:text-foreground flex max-w-full items-center gap-1.5 rounded py-0.5 text-left"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <ChevronRightIcon
      class="size-4 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
      aria-hidden="true"
    />
    <span class="truncate">{label}</span>
    {#if items.length > 1}
      <span class="truncate font-mono opacity-70">{types.join(', ')}</span>
    {/if}
  </button>
  {#if open}
    <div class="mt-1 flex flex-col gap-1.5 pl-5.5">
      {#each items as it (it.id)}
        <div>
          {#if items.length > 1}
            <div class="mb-0.5 font-mono">{it.sdkType}</div>
          {/if}
          <pre
            class="bg-muted text-foreground max-h-80 overflow-auto rounded p-2 font-mono text-[0.6875rem] leading-snug">{prettyJson(
              it.raw,
            )}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>

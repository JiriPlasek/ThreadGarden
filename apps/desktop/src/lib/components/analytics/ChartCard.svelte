<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '#lib/utils.js';

  /**
   * One chart of the Analytics view (v1.3 §4): a titled figure with a
   * one-line description and a "Show data" toggle that reveals the chart's
   * table view, the accessible twin of every chart. `empty` replaces the
   * chart (and the toggle) when the range has no data for it.
   */
  let {
    id,
    title,
    description,
    empty = null,
    class: className,
    children,
    table,
  }: {
    /** Prefix of the figure's element ids (title, description, table). */
    id: string;
    title: string;
    description: string;
    /** Shown instead of the chart when set. */
    empty?: string | null;
    class?: string;
    children: Snippet;
    table: Snippet;
  } = $props();

  let showData = $state(false);
</script>

<figure
  class={cn('bg-background flex min-w-0 flex-col gap-3 rounded-lg border p-4', className)}
  aria-labelledby="{id}-title"
  aria-describedby="{id}-desc"
  data-chart={id}
>
  <figcaption class="flex items-start gap-3">
    <div class="min-w-0 flex-1">
      <h3 id="{id}-title" class="text-sm font-medium">{title}</h3>
      <p id="{id}-desc" class="text-muted-foreground text-xs">{description}</p>
    </div>
    {#if !empty}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded px-1.5 py-0.5 text-xs outline-none hover:underline focus-visible:ring-2"
        aria-expanded={showData}
        aria-controls="{id}-data"
        onclick={() => (showData = !showData)}>{showData ? 'Hide data' : 'Show data'}</button
      >
    {/if}
  </figcaption>
  {#if empty}
    <p class="text-muted-foreground py-6 text-center text-sm">{empty}</p>
  {:else}
    {@render children()}
    <div
      id="{id}-data"
      hidden={!showData}
      class="max-h-72 overflow-auto rounded-md border [scrollbar-width:thin]"
    >
      {#if showData}{@render table()}{/if}
    </div>
  {/if}
</figure>

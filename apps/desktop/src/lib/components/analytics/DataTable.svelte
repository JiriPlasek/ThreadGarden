<script lang="ts">
  import { full } from './format';

  /** The table view of a chart: every value it plots, numbers right-aligned and in full. */
  let {
    caption,
    columns,
    rows,
  }: {
    caption: string;
    columns: string[];
    /** One row per mark; the first cell names it. */
    rows: (string | number)[][];
  } = $props();
</script>

<table class="w-full border-collapse text-xs">
  <caption class="sr-only">{caption}</caption>
  <thead class="bg-muted/60 sticky top-0">
    <tr>
      {#each columns as column, i (i)}
        <th scope="col" class="px-2 py-1 font-medium {i === 0 ? 'text-left' : 'text-right'}"
          >{column}</th
        >
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each rows as row, r (r)}
      <tr class="border-t">
        {#each row as cell, i (i)}
          {#if i === 0}
            <th scope="row" class="px-2 py-1 text-left font-normal">{cell}</th>
          {:else}
            <td class="px-2 py-1 text-right tabular-nums"
              >{typeof cell === 'number' ? full(cell) : cell}</td
            >
          {/if}
        {/each}
      </tr>
    {/each}
  </tbody>
</table>

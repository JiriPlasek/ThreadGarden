<script lang="ts" module>
  export type BarItem = { key: string; label: string; value: number };

  /** A horizontal bar with a rounded data end (right) and a square baseline (left). */
  export const roundedRight = (len: number, h: number, r = 4): string => {
    const rr = Math.max(0, Math.min(r, h / 2, len));
    if (len <= 0) return '';
    return `M0,0H${len - rr}Q${len},0 ${len},${rr}V${h - rr}Q${len},${h} ${len - rr},${h}H0Z`;
  };
</script>

<script lang="ts">
  import { cn } from '#lib/utils.js';
  import { compact, full } from './format';

  /**
   * Ranked horizontal bars, largest first, in one hue (v1.3 analytics): the
   * name, the bar and its value at the tip. With `onSelect` every row is a
   * button (the project bars filter the view to that project).
   */
  let {
    label,
    items,
    unit,
    color = 'var(--viz-s1)',
    onSelect,
    selected = null,
  }: {
    /** The list's accessible name. */
    label: string;
    items: readonly BarItem[];
    /** Unit of the values for the accessible names ("messages", "calls"). */
    unit: string;
    color?: string;
    onSelect?: ((key: string) => void) | undefined;
    selected?: string | null;
  } = $props();

  const BAR_H = 10;
  const max = $derived(Math.max(1, ...items.map((i) => i.value)));
  let trackW = $state(0);
</script>

{#snippet row(item: BarItem)}
  <span class="min-w-0 truncate text-left" title={item.label}>{item.label}</span>
  <span class="min-w-0" bind:clientWidth={trackW}>
    {#if trackW > 0}
      <svg width={trackW} height={BAR_H} class="block" aria-hidden="true">
        <path d={roundedRight((item.value / max) * trackW, BAR_H)} fill={color} />
      </svg>
    {/if}
  </span>
  <span class="text-muted-foreground text-right tabular-nums" title={full(item.value)}
    >{compact(item.value)}</span
  >
{/snippet}

<ol
  class="grid grid-cols-[minmax(5rem,38%)_1fr_auto] items-center gap-x-3 gap-y-1 text-xs"
  aria-label={label}
>
  {#each items as item (item.key)}
    <li class="col-span-3 grid grid-cols-subgrid items-center">
      {#if onSelect}
        <button
          type="button"
          class={cn(
            'hover:bg-muted/70 focus-visible:ring-ring/50 col-span-3 -mx-1.5 grid grid-cols-subgrid items-center rounded px-1.5 py-0.5 outline-none focus-visible:ring-2',
            selected === item.key && 'bg-muted font-medium',
          )}
          aria-pressed={selected === item.key}
          aria-label="{item.label}: {full(item.value)} {unit}"
          onclick={() => onSelect(item.key)}
        >
          {@render row(item)}
        </button>
      {:else}
        <div
          class="col-span-3 grid grid-cols-subgrid items-center py-0.5"
          aria-label="{item.label}: {full(item.value)} {unit}"
          role="group"
        >
          {@render row(item)}
        </div>
      {/if}
    </li>
  {/each}
</ol>

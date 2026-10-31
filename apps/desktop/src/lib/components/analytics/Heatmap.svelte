<script lang="ts" module>
  /** Steps of the sequential scale (more is darker in light mode, brighter in dark). */
  export const STEPS = 6;

  /** The scale step of `value`: 0 for nothing, else 1 … STEPS by its share of `max`. */
  export const stepOf = (value: number, max: number): number =>
    value <= 0 || max <= 0 ? 0 : Math.min(STEPS, Math.max(1, Math.ceil((value / max) * STEPS)));
</script>

<script lang="ts">
  import { full, hourLabel, WEEKDAYS, WEEKDAYS_LONG } from './format';

  /**
   * When you work (v1.3 analytics): messages per weekday (rows, Monday
   * first) and hour (columns) in one sequential hue, with a scale legend.
   * Hover a cell, or focus the grid and move with the arrow keys, to read it.
   */
  let { label, values }: { label: string; values: readonly (readonly number[])[] } = $props();

  const LEFT = 34;
  const TOP = 16;
  const GAP = 2;

  let width = $state(0);
  let at = $state<{ d: number; h: number } | null>(null);

  const cell = $derived(Math.max(6, Math.min(30, (width - LEFT) / 24)));
  const cellH = $derived(Math.min(22, Math.max(12, cell * 0.8)));
  const max = $derived(Math.max(0, ...values.flat()));
  const fill = (v: number): string => {
    const s = stepOf(v, max);
    return s === 0 ? 'var(--viz-empty)' : `var(--viz-seq-${s})`;
  };
  const readout = $derived(
    at
      ? `${WEEKDAYS_LONG[at.d]} ${hourLabel(at.h)}–${hourLabel((at.h + 1) % 24)}: ${full(values[at.d]?.[at.h] ?? 0)} messages`
      : '',
  );

  const onKey = (e: KeyboardEvent): void => {
    const cur = at ?? { d: 0, h: 9 };
    const moves: Record<string, [number, number]> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    at = { d: (cur.d + m[0] + 7) % 7, h: (cur.h + m[1] + 24) % 24 };
  };
</script>

<!-- The grid reads out its cells with the arrow keys (the same as on hover). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="focus-visible:ring-ring/50 relative rounded outline-none focus-visible:ring-2"
  bind:clientWidth={width}
  role="group"
  tabindex="0"
  aria-label="{label}: use the arrow keys to read each hour"
  onkeydown={onKey}
  onfocus={() => (at ??= { d: 0, h: 9 })}
  onblur={() => (at = null)}
  onpointerleave={() => (at = null)}
>
  {#if width > 0}
    <svg
      width={LEFT + cell * 24}
      height={TOP + cellH * 7}
      role="img"
      aria-label={label}
      class="block"
    >
      <desc
        >Messages per weekday and hour; darker cells had more. The table view lists every value.</desc
      >
      {#each [0, 3, 6, 9, 12, 15, 18, 21] as h (h)}
        <text
          x={LEFT + cell * h}
          y={TOP - 5}
          class="fill-muted-foreground text-[0.625rem] tabular-nums"
          >{String(h).padStart(2, '0')}</text
        >
      {/each}
      {#each WEEKDAYS as day, d (day)}
        <text
          x={0}
          y={TOP + cellH * d + cellH / 2}
          dy="0.32em"
          class="fill-muted-foreground text-[0.625rem]">{day}</text
        >
        {#each values[d] ?? [] as v, h (h)}
          <rect
            role="presentation"
            x={LEFT + cell * h}
            y={TOP + cellH * d}
            width={cell - GAP}
            height={cellH - GAP}
            rx="2"
            fill={fill(v)}
            stroke={at?.d === d && at?.h === h ? 'var(--foreground)' : 'none'}
            stroke-width="1.5"
            onpointerenter={() => (at = { d, h })}
          />
        {/each}
      {/each}
    </svg>
  {/if}
  <div
    class="text-muted-foreground mt-2 flex items-center gap-1.5 text-[0.625rem]"
    aria-hidden="true"
  >
    <span>Fewer</span>
    <span class="size-2.5 rounded-sm" style:background="var(--viz-empty)"></span>
    {#each Array.from({ length: STEPS }, (_, i) => i + 1) as s (s)}
      <span class="size-2.5 rounded-sm" style:background="var(--viz-seq-{s})"></span>
    {/each}
    <span>More</span>
    <span class="text-foreground ml-auto min-h-4 text-xs">{readout}</span>
  </div>
  <span class="sr-only" aria-live="polite">{readout}</span>
</div>

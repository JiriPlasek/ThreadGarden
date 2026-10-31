<script lang="ts" module>
  /** One series of marks: its name (legend, tooltip), color (a CSS color) and a value per day. */
  export type Series = { name: string; color: string; values: readonly number[] };

  /** A bar with a rounded data end (top) and a square baseline. */
  export const roundedTop = (x: number, top: number, w: number, h: number, r: number): string => {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    if (rr === 0) return `M${x},${top + h}V${top}H${x + w}V${top + h}Z`;
    return (
      `M${x},${top + h}V${top + rr}Q${x},${top} ${x + rr},${top}` +
      `H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${top + h}Z`
    );
  };
</script>

<script lang="ts">
  import { compact, full, labelIndices, longDay, niceTicks, shortDay } from './format';

  /**
   * Columns over days (v1.3 analytics): one series, or several stacked with
   * a 2 px surface gap between segments (then a legend names them). An
   * optional `line` is drawn as its own small panel below, on its own axis,
   * sharing the days (two measures, never two scales on one plot). Hovering
   * a day, or moving through the days with the arrow keys once the chart has
   * focus, shows every value of that day.
   */
  let {
    id,
    label,
    days,
    series,
    line,
    week = false,
    height = 150,
  }: {
    id: string;
    /** What the chart shows, for its keyboard group and SVG title. */
    label: string;
    days: readonly string[];
    series: readonly Series[];
    line?: Series | undefined;
    /** Each day starts a week (long ranges). */
    week?: boolean;
    height?: number;
  } = $props();

  const LEFT = 44;
  const RIGHT = 8;
  const TOP = 14;
  const AXIS = 22;
  const LINE_H = 52;
  const GAP = 26;

  let width = $state(0);
  let hovered = $state<number | null>(null);

  const n = $derived(days.length);
  const plotW = $derived(Math.max(0, width - LEFT - RIGHT));
  const band = $derived(n > 0 ? plotW / n : 0);
  const barW = $derived(Math.max(1, Math.min(24, band > 4 ? band - 2 : band * 0.8)));
  const totals = $derived(
    days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
  );
  const ticks = $derived(niceTicks(Math.max(0, ...totals)));
  const top = $derived(ticks.at(-1) || 1);
  const y = (v: number): number => TOP + height - (v / top) * height;

  const lineTop = $derived(TOP + height + GAP);
  const lineTicks = $derived(line ? niceTicks(Math.max(0, ...line.values), 2) : []);
  const lineMax = $derived(lineTicks.at(-1) || 1);
  const ly = (v: number): number => lineTop + LINE_H - (v / lineMax) * LINE_H;
  const plotBottom = $derived(line ? lineTop + LINE_H : TOP + height);
  const svgH = $derived(plotBottom + AXIS);

  const cx = (i: number): number => LEFT + band * i + band / 2;
  const labels = $derived(labelIndices(n, plotW, week ? 72 : 60));

  type Segment = { key: string; d: string; color: string };
  const bars = $derived.by((): Segment[] => {
    const out: Segment[] = [];
    for (let i = 0; i < n; i++) {
      const x = cx(i) - barW / 2;
      let base = 0;
      const stack = series.map((s) => s.values[i] ?? 0);
      let last = -1;
      stack.forEach((v, s) => {
        if (v > 0) last = s;
      });
      stack.forEach((v, s) => {
        if (v <= 0) return;
        const y0 = y(base);
        const y1 = y(base + v);
        base += v;
        // The surface gap sits between segments, never under the bottom one.
        const gap = s > 0 && y0 - y1 > 3 ? 2 : 0;
        const h = Math.max(0.5, y0 - y1 - gap);
        out.push({
          key: `${i}:${s}`,
          d: roundedTop(x, y1, barW, h, s === last ? 4 : 0),
          color: series[s]!.color,
        });
      });
    }
    return out;
  });

  const linePath = $derived(
    line ? line.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${cx(i)},${ly(v)}`).join('') : '',
  );
  const areaPath = $derived(
    line && n > 0 ? `${linePath}L${cx(n - 1)},${ly(0)}L${cx(0)},${ly(0)}Z` : '',
  );

  const readout = $derived.by(() => {
    if (hovered === null || hovered >= n) return null;
    const i = hovered;
    const rows = series.map((s) => ({ name: s.name, color: s.color, value: s.values[i] ?? 0 }));
    return {
      day: longDay(days[i]!, week),
      rows,
      total: series.length > 1 ? totals[i]! : null,
      line: line ? { name: line.name, color: line.color, value: line.values[i] ?? 0 } : null,
    };
  });
  const readoutText = $derived(
    readout
      ? [
          readout.day,
          ...readout.rows.map((r) => `${r.name} ${full(r.value)}`),
          ...(readout.total !== null ? [`Total ${full(readout.total)}`] : []),
          ...(readout.line ? [`${readout.line.name} ${full(readout.line.value)}`] : []),
        ].join(', ')
      : '',
  );
  const tipLeft = $derived(
    hovered === null ? 0 : Math.max(0, Math.min(width - 176, cx(hovered) + 12)),
  );

  const onKey = (e: KeyboardEvent): void => {
    if (n === 0) return;
    const i = hovered ?? n - 1;
    let next: number;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    hovered = next;
  };
</script>

<!-- The chart reads out its values with the arrow keys (the same as on hover). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="focus-visible:ring-ring/50 relative rounded outline-none focus-visible:ring-2"
  bind:clientWidth={width}
  role="group"
  tabindex="0"
  aria-label="{label}: use the arrow keys to read each {week ? 'week' : 'day'}"
  onkeydown={onKey}
  onfocus={() => (hovered ??= n - 1)}
  onblur={() => (hovered = null)}
  onpointerleave={() => (hovered = null)}
>
  {#if series.length > 1}
    <ul
      class="text-muted-foreground mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
      aria-hidden="true"
    >
      {#each series as s (s.name)}
        <li class="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden="true"
            ><rect width="10" height="10" rx="2" fill={s.color} /></svg
          >{s.name}
        </li>
      {/each}
    </ul>
  {/if}
  {#if width > 0}
    <svg {width} height={svgH} role="img" aria-labelledby="{id}-svg-title" class="block">
      <title id="{id}-svg-title">{label}</title>
      <desc
        >{series.map((s) => s.name).join(', ')}{line ? ` and ${line.name}` : ''} per {week
          ? 'week'
          : 'day'}, {days.length > 0 ? `${shortDay(days[0]!)} to ${shortDay(days.at(-1)!)}` : ''}.
        The table view lists every value.</desc
      >
      {#if hovered !== null}
        <rect
          x={LEFT + band * hovered}
          y={TOP - 6}
          width={band}
          height={plotBottom - TOP + 6}
          fill="currentColor"
          opacity="0.06"
        />
      {/if}
      {#each ticks as t (t)}
        <line
          x1={LEFT}
          x2={LEFT + plotW}
          y1={y(t)}
          y2={y(t)}
          stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
          stroke-width="1"
          shape-rendering="crispEdges"
        />
        <text
          x={LEFT - 6}
          y={y(t)}
          dy="0.32em"
          text-anchor="end"
          class="fill-muted-foreground text-[0.625rem] tabular-nums">{compact(t)}</text
        >
      {/each}
      {#if line}
        <text x={LEFT} y={TOP - 4} class="fill-muted-foreground text-[0.625rem]"
          >{series[0]?.name}</text
        >
      {/if}
      {#each bars as b (b.key)}
        <path d={b.d} fill={b.color} />
      {/each}
      {#if line}
        <text x={LEFT} y={lineTop - 6} class="fill-muted-foreground text-[0.625rem]"
          >{line.name}</text
        >
        {#each lineTicks as t (t)}
          <line
            x1={LEFT}
            x2={LEFT + plotW}
            y1={ly(t)}
            y2={ly(t)}
            stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
            stroke-width="1"
            shape-rendering="crispEdges"
          />
          <text
            x={LEFT - 6}
            y={ly(t)}
            dy="0.32em"
            text-anchor="end"
            class="fill-muted-foreground text-[0.625rem] tabular-nums">{compact(t)}</text
          >
        {/each}
        <path d={areaPath} fill={line.color} opacity="0.1" />
        <path
          d={linePath}
          fill="none"
          stroke={line.color}
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        {#if n > 0}
          {@const at = hovered ?? n - 1}
          <circle
            cx={cx(at)}
            cy={ly(line.values[at] ?? 0)}
            r="4"
            fill={line.color}
            stroke="var(--background)"
            stroke-width="2"
          />
        {/if}
      {/if}
      {#each labels as i (i)}
        <text
          x={cx(i)}
          y={plotBottom + 15}
          text-anchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}
          dx={i === 0 && n > 1 ? -band / 2 : i === n - 1 && n > 1 ? band / 2 : 0}
          class="fill-muted-foreground text-[0.625rem]">{shortDay(days[i]!)}</text
        >
      {/each}
      {#each days as day, i (day)}
        <rect
          role="presentation"
          x={LEFT + band * i}
          y={0}
          width={band}
          height={plotBottom}
          fill="transparent"
          onpointerenter={() => (hovered = i)}
        />
      {/each}
    </svg>
  {/if}
  {#if readout}
    <div
      class="bg-popover text-popover-foreground pointer-events-none absolute top-6 z-10 w-max max-w-72 min-w-44 rounded-md border px-2.5 py-2 text-xs shadow-md"
      style:left="{tipLeft}px"
      aria-hidden="true"
    >
      <div class="text-muted-foreground mb-1">{readout.day}</div>
      {#each readout.rows as r (r.name)}
        <div class="flex items-center gap-2">
          <span class="h-0.5 w-3 shrink-0 rounded" style:background={r.color}></span>
          <span class="font-semibold tabular-nums">{full(r.value)}</span>
          <span class="text-muted-foreground truncate">{r.name}</span>
        </div>
      {/each}
      {#if readout.total !== null}
        <div class="mt-0.5 flex items-center gap-2 border-t pt-0.5">
          <span class="w-3 shrink-0"></span>
          <span class="font-semibold tabular-nums">{full(readout.total)}</span>
          <span class="text-muted-foreground">Total</span>
        </div>
      {/if}
      {#if readout.line}
        <div class="flex items-center gap-2">
          <span class="h-0.5 w-3 shrink-0 rounded" style:background={readout.line.color}></span>
          <span class="font-semibold tabular-nums">{full(readout.line.value)}</span>
          <span class="text-muted-foreground truncate">{readout.line.name}</span>
        </div>
      {/if}
    </div>
  {/if}
  <span class="sr-only" aria-live="polite">{readoutText}</span>
</div>

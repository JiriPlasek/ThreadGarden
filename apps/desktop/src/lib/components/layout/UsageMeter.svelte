<script lang="ts">
  import GaugeIcon from '@lucide/svelte/icons/gauge';
  import { clockTime, percentText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import { windowLabel, windowStatus } from '#lib/state/usage.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * v1.3 B: the bottom strip's usage meter — the 5-hour window's use and its
   * reset time; amber at a warning, red while the limit refuses. Hidden while
   * nothing is known. Opens the Usage dialog.
   */
  const { usage } = useApp();

  const w = $derived(usage.meter);
  const status = $derived(w ? windowStatus(w, usage.now) : undefined);
  /** A window that has reset is used anew: its old percentage no longer applies. */
  const reset = $derived(w?.resetsAt !== undefined && w.resetsAt <= usage.now);
  const text = $derived.by(() => {
    if (!w) return '';
    if (status === 'rejected') return 'Limit reached';
    if (reset || w.utilization === undefined) return '5h';
    return percentText(w.utilization);
  });
  const until = $derived(w?.resetsAt !== undefined && !reset ? clockTime(w.resetsAt) : null);
  const label = $derived.by(() => {
    if (!w) return '';
    const parts = [`Usage: ${windowLabel(w)}`];
    if (status === 'rejected') parts.push('limit reached');
    else if (!reset && w.utilization !== undefined)
      parts.push(`${percentText(w.utilization)} used`);
    if (until) parts.push(`resets at ${until}`);
    return parts.join(', ');
  });
</script>

{#if w}
  <button
    type="button"
    class={cn(
      'hover:bg-accent focus-visible:ring-ring/50 flex h-6 shrink-0 items-center gap-1 rounded px-1.5 tabular-nums outline-none focus-visible:ring-2',
      status === 'rejected'
        ? 'text-red-700 dark:text-red-400'
        : status === 'allowed_warning'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground',
    )}
    aria-label={label}
    title="{label} · open Usage"
    data-usage-status={status ?? 'unknown'}
    onclick={() => usage.open()}
  >
    <GaugeIcon class="size-3.5" aria-hidden="true" />
    <span>{text}</span>
    {#if until}
      <span class="opacity-70">· {until}</span>
    {/if}
  </button>
{/if}

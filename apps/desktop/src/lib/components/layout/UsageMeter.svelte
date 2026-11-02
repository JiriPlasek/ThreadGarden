<script lang="ts">
  import GaugeIcon from '@lucide/svelte/icons/gauge';
  import type { UsageWindow } from '@threadgarden/protocol';
  import { clockTime, percentText, resetText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import { windowLabel, windowStatus } from '#lib/state/usage.svelte.js';
  import { chipWindows, type UsageEntry } from '#lib/usage/accounts.js';
  import { cn } from '#lib/utils.js';

  /**
   * The bottom strip's usage: one chip per claude.ai account (usage-per-account
   * design §4) with its 5-hour, weekly and per-model figures; amber at a
   * warning, red while the limit refuses. Hovering lists the email and every
   * window with its reset. No chip for an API key, a provider, or an account
   * without a 5-hour reading. A narrow bar shows each chip's 5-hour figure
   * alone. Any chip opens the Usage dialog.
   */
  type Props = {
    /** Only the 5-hour figures; measured from the bar when not given. */
    compact?: boolean;
  };
  const { compact }: Props = $props();
  const { usage, usageAccounts, machines } = useApp();

  /** Below this bar width the chips shrink to their 5-hour figure. */
  const NARROW = 960;

  let root = $state<HTMLElement>();
  let narrow = $state(false);
  const isCompact = $derived(compact ?? narrow);

  $effect(() => {
    const bar = root?.parentElement;
    if (!bar || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => (narrow = bar.clientWidth < NARROW));
    observer.observe(bar);
    return () => observer.disconnect();
  });

  const now = $derived(usage.now);
  const hasReset = (w: UsageWindow): boolean => w.resetsAt !== undefined && w.resetsAt <= now;

  const SHORT: Record<string, string> = {
    five_hour: '5h',
    current: '5h',
    seven_day: 'Week',
    seven_day_opus: 'Opus',
    seven_day_sonnet: 'Sonnet',
  };
  const shortLabel = (w: UsageWindow): string =>
    SHORT[w.key] ?? (w.key.startsWith('model:') ? (w.label ?? w.key.slice(6)) : w.key);

  const isFiveHour = (w: UsageWindow): boolean => w.key === 'five_hour' || w.key === 'current';

  /** One figure of a chip: "5h 42%", or just the label once its window has reset. */
  const figure = (w: UsageWindow): string => {
    const label = shortLabel(w);
    if (windowStatus(w, now) === 'rejected' && isFiveHour(w)) return `${label} Limit reached`;
    if (hasReset(w) || w.utilization === undefined) return label;
    return `${label} ${percentText(w.utilization)}`;
  };

  const tone = (w: UsageWindow): string => {
    const status = windowStatus(w, now);
    return status === 'rejected'
      ? 'text-red-700 dark:text-red-400'
      : status === 'allowed_warning'
        ? 'text-amber-700 dark:text-amber-400'
        : '';
  };

  const line = (w: UsageWindow): string => {
    const parts = [windowLabel(w)];
    if (hasReset(w)) return `${parts[0]}: ${resetText(w.resetsAt!, now)}`;
    const detail: string[] = [];
    if (w.utilization !== undefined) detail.push(percentText(w.utilization));
    if (w.resetsAt !== undefined) detail.push(resetText(w.resetsAt, now));
    return detail.length > 0 ? `${parts[0]}: ${detail.join(', ')}` : parts[0]!;
  };

  type Chip = {
    key: string;
    windows: UsageWindow[];
    where: string;
    asOf: string | undefined;
    title: string;
  };

  /** The chips: an entry shows when it is a login with a 5-hour reading. */
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = [];
    for (const e of usageAccounts.entries as UsageEntry[]) {
      if (e.account && e.account.kind !== 'login') continue;
      const windows = chipWindows(e);
      if (!windows.some(isFiveHour)) continue;
      const asOf = e.asOf === undefined ? undefined : clockTime(e.asOf);
      out.push({
        key: e.key,
        windows,
        where: machines.several ? e.machines.map((m) => m.name).join(', ') : '',
        asOf,
        title: [
          e.account?.email ?? 'Account not known yet',
          ...e.windows.map(line),
          ...(asOf ? [`As of ${asOf}`] : []),
        ].join('\n'),
      });
    }
    return out;
  });
</script>

<div bind:this={root} class="flex shrink-0 items-center gap-1 whitespace-nowrap">
  {#each chips as chip (chip.key)}
    {@const shown = isCompact ? chip.windows.filter(isFiveHour).slice(0, 1) : chip.windows}
    <button
      type="button"
      class="hover:bg-accent focus-visible:ring-ring/50 text-muted-foreground flex h-6 shrink-0 items-center gap-1 rounded px-1.5 tabular-nums outline-none focus-visible:ring-2"
      aria-label="Usage: {chip.title.replaceAll('\n', '; ')}"
      title={chip.title}
      data-usage-status={windowStatus(chip.windows[0]!, now) ?? 'unknown'}
      onclick={() => usageAccounts.open()}
    >
      <GaugeIcon class="size-3.5" aria-hidden="true" />
      {#if chip.where && !isCompact}
        <span>{chip.where} ·</span>
      {/if}
      {#each shown as w, i (w.key)}
        <span class={cn(tone(w))}>{i > 0 ? ' · ' : ''}{figure(w)}</span>
      {/each}
      {#if chip.asOf && !isCompact}
        <span class="opacity-70">· as of {chip.asOf}</span>
      {/if}
    </button>
  {/each}
</div>

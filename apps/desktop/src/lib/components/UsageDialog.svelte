<script lang="ts">
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import type { UsageWindow } from '@pahub/protocol';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { agoText, percentText, resetText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import { sortWindows, windowLabel, windowStatus } from '#lib/state/usage.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * v1.3 B "Usage" (spec §3): one bar per known window — 5-hour, weekly,
   * weekly per model, overage and extra usage — with its use, when it resets
   * and when pahub last saw it, plus the plan when known. Opened from the
   * strip's meter or "Usage" in Ctrl/Cmd+K; opening asks a running chat for a
   * fresh reading (the service never starts one for it).
   */
  const { usage } = useApp();

  let now = $state(Date.now());
  $effect(() => {
    if (!usage.dialogOpen) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const info = $derived(usage.value);
  const windows = $derived(sortWindows(info.windows));
  const noLimits = $derived(info.rateLimitsAvailable === false);
  const plan = $derived(
    info.subscriptionType
      ? `${info.subscriptionType[0]!.toUpperCase()}${info.subscriptionType.slice(1)} plan`
      : null,
  );

  const STATUS_TEXT: Record<NonNullable<UsageWindow['status']>, string> = {
    allowed: '',
    allowed_warning: 'Close to the limit',
    rejected: 'Limit reached',
  };

  /** Width of a window's bar: its use, full while refused. */
  const fill = (w: UsageWindow): number => {
    if (windowStatus(w, now) === 'rejected') return 100;
    if (w.resetsAt !== undefined && w.resetsAt <= now) return 0;
    return Math.min(100, Math.max(0, w.utilization ?? 0));
  };

  const credits = (w: UsageWindow): string | null => {
    const c = w.credits;
    if (!c) return null;
    if (c.enabled === false) return 'Not enabled';
    const unit = c.currency ? ` ${c.currency}` : '';
    if (c.used !== undefined && c.limit !== undefined) return `${c.used} of ${c.limit}${unit}`;
    if (c.used !== undefined) return `${c.used}${unit} used`;
    return null;
  };
</script>

<Dialog.Root open={usage.dialogOpen} onOpenChange={(open) => (usage.dialogOpen = open)}>
  <Dialog.Content class="max-h-[85vh] gap-4 overflow-y-auto p-5 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-base">Usage</Dialog.Title>
      <Dialog.Description class="text-xs">
        {#if noLimits}
          Plan usage limits do not apply to this account (an API key or a cloud provider).
        {:else}
          Your Claude plan's usage limits, as Claude Code last reported them{plan
            ? ` · ${plan}`
            : ''}.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if windows.length === 0}
      <p class="text-muted-foreground text-sm" role="status">
        {#if noLimits}
          Nothing to show.
        {:else}
          Nothing known yet. Usage shows up once a chat has run in pahub.
        {/if}
      </p>
    {:else}
      <ul class="flex flex-col gap-3" aria-label="Usage limits">
        {#each windows as w (w.key)}
          {@const status = windowStatus(w, now)}
          {@const pct = fill(w)}
          {@const extra = credits(w)}
          {@const reset = w.resetsAt !== undefined && w.resetsAt <= now}
          <li class="flex flex-col gap-1">
            <div class="flex items-baseline gap-2 text-sm">
              <span class="min-w-0 flex-1 truncate font-medium">{windowLabel(w)}</span>
              {#if status && STATUS_TEXT[status]}
                <span
                  class={cn(
                    'text-xs font-medium',
                    status === 'rejected'
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-amber-700 dark:text-amber-400',
                  )}>{STATUS_TEXT[status]}</span
                >
              {/if}
              {#if w.utilization !== undefined && !reset}
                <span class="text-muted-foreground text-xs tabular-nums"
                  >{percentText(w.utilization)}</span
                >
              {/if}
            </div>
            <div
              class="bg-muted h-1.5 overflow-hidden rounded-full"
              role="meter"
              aria-label="{windowLabel(w)} used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
            >
              <div
                class={cn(
                  'h-full rounded-full',
                  status === 'rejected'
                    ? 'bg-red-500'
                    : status === 'allowed_warning' || pct >= 80
                      ? 'bg-amber-500'
                      : 'bg-primary',
                )}
                style:width="{pct}%"
              ></div>
            </div>
            <p class="text-muted-foreground text-xs">
              {#if extra}{extra} ·{/if}
              {#if w.resetsAt !== undefined}{resetText(w.resetsAt, now)} ·{/if}
              seen {agoText(w.observedAt, now)}
            </p>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="text-muted-foreground flex items-center gap-2 text-xs">
      <span class="flex-1" role="status">
        {usage.refreshing ? 'Asking a running chat for the latest usage…' : ''}
      </span>
      <button
        type="button"
        class="hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2"
        disabled={usage.refreshing}
        onclick={() => void usage.refresh().catch(() => {})}
      >
        <RefreshCwIcon class="size-3.5" aria-hidden="true" /> Refresh
      </button>
    </div>
  </Dialog.Content>
</Dialog.Root>

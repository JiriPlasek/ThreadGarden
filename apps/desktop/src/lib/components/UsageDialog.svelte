<script lang="ts">
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import type { UsageWindow } from '@threadgarden/protocol';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { agoText, clockTime, percentText, resetText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import { sortWindows, windowLabel, windowStatus } from '#lib/state/usage.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * v1.3 B "Usage" (spec §3): one bar per known window — 5-hour, weekly,
   * weekly per model, overage and extra usage — with its use, when it resets
   * and when Threadgarden last saw it, plus the plan when known. Opened from the
   * strip's meter or "Usage" in Ctrl/Cmd+K; opening asks a running chat for a
   * fresh reading (the service never starts one for it).
   */
  const { usageAccounts } = useApp();

  let now = $state(Date.now());
  $effect(() => {
    if (!usageAccounts.dialogOpen) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const capital = (t: string): string => `${t[0]!.toUpperCase()}${t.slice(1)}`;

  /** What a section shows for one account entry. */
  const sections = $derived(
    usageAccounts.entries.map((e) => {
      const a = e.account;
      const subscription =
        a?.plan ?? e.machines.find((m) => m.state.subscriptionType)?.state.subscriptionType;
      const noLimits =
        (a !== undefined && a.kind !== 'login') ||
        e.machines.some((m) => m.state.rateLimitsAvailable === false);
      const first = e.machines[0]!.name;
      const email = a?.kind === 'login' ? a.email : undefined;
      const kindText = a?.kind === 'apiKey' ? 'API key' : a?.kind === 'provider' ? a.provider : '';
      const plan = !noLimits && subscription ? `${capital(subscription)} plan` : null;
      const title = email ?? first;
      const detail = noLimits ? (kindText ? kindText : null) : plan;
      return {
        key: e.key,
        title,
        heading: detail ? `${title} · ${detail}` : title,
        // An email names the account; its machines then sit beside it.
        machines: email ? e.machines.map((m) => m.name).join(', ') : '',
        noLimits,
        asOf: e.asOf,
        windows: sortWindows(e.windows),
      };
    }),
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

<Dialog.Root
  open={usageAccounts.dialogOpen}
  onOpenChange={(open) => (usageAccounts.dialogOpen = open)}
>
  <Dialog.Content class="max-h-[85vh] gap-4 overflow-y-auto p-5 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-base">Usage</Dialog.Title>
      <Dialog.Description class="text-xs">
        Your Claude plan's usage limits, as Claude Code last reported them.
      </Dialog.Description>
    </Dialog.Header>

    {#if sections.length === 0}
      <p class="text-muted-foreground text-sm" role="status">
        Nothing known yet. Usage shows up once a chat has run in Threadgarden.
      </p>
    {/if}

    {#each sections as section (section.key)}
      <!-- min-w-0: the dialog is a grid, whose column would otherwise grow to a long name. -->
      <section class="flex min-w-0 flex-col gap-3" aria-label={section.title}>
        <div class="flex flex-col gap-0.5">
          <div class="flex items-baseline gap-2 text-sm">
            <h3 class="min-w-0 flex-1 truncate font-semibold" title={section.heading}>
              {section.heading}
            </h3>
            {#if section.asOf !== undefined}
              <span class="text-muted-foreground shrink-0 text-xs"
                >as of {clockTime(section.asOf)}</span
              >
            {/if}
          </div>
          {#if section.machines}
            <p class="text-muted-foreground truncate text-xs" title={section.machines}>
              {section.machines}
            </p>
          {/if}
        </div>
        {#if section.windows.length === 0}
          <p class="text-muted-foreground text-sm" role="status">
            {#if section.noLimits}
              Plan usage limits do not apply to this account (an API key or a cloud provider).
            {:else}
              No reading yet
            {/if}
          </p>
        {:else}
          <ul class="flex flex-col gap-3" aria-label="Usage limits">
            {#each section.windows as w (w.key)}
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
      </section>
    {/each}

    <div class="text-muted-foreground flex items-center gap-2 text-xs">
      <span class="flex-1" role="status">
        {usageAccounts.refreshing ? 'Asking a running chat for the latest usage…' : ''}
      </span>
      <button
        type="button"
        class="hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2"
        disabled={usageAccounts.refreshing}
        onclick={() => void usageAccounts.refresh()}
      >
        <RefreshCwIcon class="size-3.5" aria-hidden="true" /> Refresh
      </button>
    </div>
  </Dialog.Content>
</Dialog.Root>

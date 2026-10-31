<script lang="ts">
  import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
  import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
  import type { ScheduledSend } from '@pahub/protocol';
  import ScheduleDialog from '#lib/components/composer/ScheduleDialog.svelte';
  import { fullTime } from '#lib/format/time.js';
  import { sendTimeText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';
  import type { SendWhen } from '#lib/state/scheduled.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * v1.3 B: the chat's scheduled messages, above the composer (spec §3), in
   * the order they go out: a preview, when (click to change it), and Send now
   * / Edit / Cancel. A failed one says why and waits for Send now or Cancel.
   */
  let {
    sessionId,
    editingId,
    onEdit,
  }: {
    sessionId: string;
    /** The send open in the composer for editing, if any. */
    editingId?: string | undefined;
    onEdit: (send: ScheduledSend) => void;
  } = $props();

  const { scheduled, usage } = useApp();

  const items = $derived(scheduled.forChat(sessionId));
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let retiming = $state<ScheduledSend | null>(null);
  let retimeOpen = $state(false);

  const run = async (id: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = id;
    error = null;
    try {
      await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = null;
    }
  };

  const retime = async (when: SendWhen): Promise<void> => {
    const s = retiming;
    if (!s) return;
    await scheduled.update(s.id, when);
  };

  const preview = (s: ScheduledSend): string => {
    const line = s.text.trim().split('\n')[0] ?? '';
    if (line) return line;
    return s.imageCount === 1 ? '1 image' : `${s.imageCount} images`;
  };
</script>

{#if items.length > 0}
  <section class="bg-muted/40 rounded-md border px-2 py-1 text-xs" aria-label="Scheduled messages">
    <ul class="flex flex-col">
      {#each items as s (s.id)}
        {@const failed = s.state === 'failed'}
        <li
          class={cn('flex flex-col gap-0.5 py-1', s.id === editingId && 'opacity-60')}
          data-scheduled-id={s.id}
        >
          <div class="flex min-w-0 items-center gap-2">
            {#if failed}
              <OctagonAlertIcon class="text-destructive size-3.5 shrink-0" aria-hidden="true" />
            {:else}
              <CalendarClockIcon
                class="text-muted-foreground size-3.5 shrink-0"
                aria-hidden="true"
              />
            {/if}
            <span class="min-w-0 flex-1 truncate" title={s.text}>
              {preview(s)}{#if s.imageCount > 0 && s.text.trim()}
                <span class="text-muted-foreground">
                  · {s.imageCount === 1 ? '1 image' : `${s.imageCount} images`}</span
                >{/if}
            </span>
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground shrink-0 tabular-nums underline-offset-2 hover:underline"
              title="{fullTime(s.sendAt)} · change the time"
              aria-label="Scheduled for {sendTimeText(s.sendAt, usage.now)}, change the time"
              onclick={() => {
                retiming = s;
                retimeOpen = true;
              }}
            >
              {failed ? 'not sent' : sendTimeText(s.sendAt, usage.now)}{s.afterLimitReset && !failed
                ? ' (limit reset)'
                : ''}
            </button>
            <button
              type="button"
              class="hover:bg-background shrink-0 rounded px-1.5 py-0.5 font-medium disabled:opacity-40"
              disabled={busy !== null}
              onclick={() => void run(s.id, () => scheduled.sendNow(s.id))}>Send now</button
            >
            <button
              type="button"
              class="hover:bg-background shrink-0 rounded px-1.5 py-0.5 disabled:opacity-40"
              disabled={busy !== null || s.id === editingId}
              onclick={() => onEdit(s)}>Edit</button
            >
            <button
              type="button"
              class="hover:bg-background hover:text-destructive shrink-0 rounded px-1.5 py-0.5 disabled:opacity-40"
              disabled={busy !== null}
              aria-label="Cancel scheduled message"
              onclick={() => void run(s.id, () => scheduled.cancel(s.id))}>Cancel</button
            >
          </div>
          {#if failed && s.error}
            <p class="text-destructive pl-5.5" role="alert">{s.error}</p>
          {:else if s.late}
            <p class="text-muted-foreground pl-5.5">Due while pahub was not running.</p>
          {/if}
        </li>
      {/each}
    </ul>
    {#if error}
      <p class="text-destructive px-0.5 pb-0.5" role="alert">{error}</p>
    {/if}
  </section>
{/if}

<ScheduleDialog
  bind:open={retimeOpen}
  title="Change the time"
  resetAt={usage.limitResetAt}
  initial={retiming?.sendAt}
  onPick={retime}
/>

<script lang="ts">
  import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
  import type { ScheduledSend } from '@pahub/protocol';
  import { sendTimeText } from '#lib/format/usage.js';
  import { cn } from '#lib/utils.js';

  /**
   * v1.3 B: the clock badge of a chat with scheduled messages (spec §3): when
   * the next one goes out; red when one could not be sent.
   */
  let {
    sends,
    now,
    class: className,
  }: { sends: readonly ScheduledSend[]; now: number; class?: string } = $props();

  const failed = $derived(sends.some((s) => s.state === 'failed'));
  const next = $derived(sends.find((s) => s.state === 'pending'));
  const label = $derived.by(() => {
    const n = sends.length;
    const what = n === 1 ? '1 scheduled message' : `${n} scheduled messages`;
    if (failed) return `${what}, one could not be sent`;
    return next ? `${what}, next ${sendTimeText(next.sendAt, now)}` : what;
  });
</script>

<span
  role="img"
  aria-label={label}
  title={label}
  class={cn('shrink-0', failed ? 'text-destructive' : 'text-sky-700 dark:text-sky-400', className)}
>
  <CalendarClockIcon class="size-3.5" aria-hidden="true" />
</span>

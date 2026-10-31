<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import {
    formatHoldUntil,
    fromDateTimeLocal,
    holdPresets,
    pickProblem,
    toDateTimeLocal,
  } from '#lib/format/hold.js';
  import { clockTime } from '#lib/format/usage.js';
  import type { SendWhen } from '#lib/state/scheduled.svelte.js';

  /**
   * v1.3 B "Schedule send…" (spec §3): when the limit resets (offered when its
   * reset is known), in 1 hour, tomorrow 09:00, or a picked date and time —
   * the date-and-time picker of "Put on hold" (v1.2). Used for a new message
   * and for changing the time of a scheduled one.
   */
  let {
    open = $bindable(false),
    resetAt,
    initial,
    title = 'Schedule send',
    onPick,
  }: {
    open?: boolean;
    /** When the usage limit resets, if one refuses now and its reset is known. */
    resetAt?: number | undefined;
    /** The current time of a scheduled send being changed (starts on "Pick"). */
    initial?: number | undefined;
    title?: string;
    /** Schedules; a rejection shows its message and keeps the dialog open. */
    onPick: (when: SendWhen) => Promise<void>;
  } = $props();

  type Choice = 'reset' | 'hour' | 'tomorrow' | 'pick';

  let choice = $state<Choice>('hour');
  let picked = $state('');
  let now = $state(Date.now());
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Each opening starts afresh: the limit's reset when there is one, else in 1 hour.
  $effect(() => {
    if (!open) return;
    now = Date.now();
    error = null;
    busy = false;
    if (initial !== undefined && initial > now) {
      choice = 'pick';
      picked = toDateTimeLocal(initial);
    } else {
      choice = resetAt !== undefined ? 'reset' : 'hour';
      picked = '';
    }
  });

  const presets = $derived(holdPresets(now));
  const inHour = $derived(now + 60 * 60_000);
  const problem = $derived(choice === 'pick' ? pickProblem(picked, now) : null);

  /** The chosen time; null while "Pick" has no valid time ahead. */
  const when = $derived.by((): SendWhen | null => {
    if (choice === 'reset') return resetAt !== undefined ? { whenLimitResets: true } : null;
    if (choice === 'hour') return { sendAt: inHour };
    if (choice === 'tomorrow') return { sendAt: presets.tomorrow };
    const t = fromDateTimeLocal(picked);
    return t !== null && t > now ? { sendAt: t } : null;
  });

  const save = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (!when || busy) return;
    busy = true;
    error = null;
    try {
      // "In 1 hour" counts from now, not from when the dialog opened.
      await onPick(choice === 'hour' ? { sendAt: Date.now() + 60 * 60_000 } : when);
      open = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };

  const optionClass =
    'hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm';
</script>

<Dialog.Root bind:open>
  <Dialog.Content showCloseButton={false} class="gap-4 p-5 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="text-base">{title}</Dialog.Title>
      <Dialog.Description class="text-sm">
        pahub sends the message then, resuming the chat if needed.
      </Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={save}>
      <fieldset class="flex flex-col gap-0.5">
        <legend class="text-muted-foreground mb-1 text-xs font-medium">Send</legend>
        {#if resetAt !== undefined}
          <label class={optionClass}>
            <input type="radio" name="schedule-when" value="reset" bind:group={choice} />
            <span class="flex-1">When the limit resets</span>
            <span class="text-muted-foreground text-xs">{clockTime(resetAt)}</span>
          </label>
        {/if}
        <label class={optionClass}>
          <input type="radio" name="schedule-when" value="hour" bind:group={choice} />
          <span class="flex-1">In 1 hour</span>
          <span class="text-muted-foreground text-xs">{clockTime(inHour)}</span>
        </label>
        <label class={optionClass}>
          <input type="radio" name="schedule-when" value="tomorrow" bind:group={choice} />
          <span class="flex-1">Tomorrow 09:00</span>
        </label>
        <label class={optionClass}>
          <input type="radio" name="schedule-when" value="pick" bind:group={choice} />
          <span class="flex-1">Pick date &amp; time</span>
          {#if choice === 'pick' && when && 'sendAt' in when}
            <span class="text-muted-foreground text-xs">{formatHoldUntil(when.sendAt, now)}</span>
          {/if}
        </label>
        {#if choice === 'pick'}
          <input
            type="datetime-local"
            aria-label="Date and time"
            aria-invalid={problem ? 'true' : undefined}
            min={toDateTimeLocal(now)}
            class="border-input focus-visible:border-ring focus-visible:ring-ring/50 ml-7 h-8 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2"
            bind:value={picked}
          />
          {#if problem}
            <p class="text-destructive ml-7 text-xs" role="alert">{problem}</p>
          {/if}
        {/if}
      </fieldset>
      {#if error}
        <p class="text-destructive text-sm" role="alert">{error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}
          >Cancel</Button
        >
        <Button type="submit" size="sm" disabled={busy || when === null}>Schedule</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

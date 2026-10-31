<script lang="ts">
  import { HOLD_NOTE_MAX } from '@pahub/protocol';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import {
    formatHoldUntil,
    fromDateTimeLocal,
    holdPresets,
    pickProblem,
    toDateTimeLocal,
  } from '#lib/format/hold.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * "Put on hold…" (v1.2 §3): until Tomorrow 09:00, Next week (Monday 09:00),
   * a picked date and time, or no date, plus an optional note. A small dialog
   * rather than an anchored popover, as it opens from menus, the bulk bar and
   * the H key alike. A chat already on hold starts from its current hold.
   */
  const { buckets } = useApp();

  type Choice = 'tomorrow' | 'nextWeek' | 'pick' | 'none';

  let choice = $state<Choice>('tomorrow');
  let picked = $state('');
  let note = $state('');
  let now = $state(Date.now());
  let busy = $state(false);
  let error = $state<string | null>(null);

  const holding = $derived(buckets.holding);
  const presets = $derived(holdPresets(now));
  const subject = $derived.by(() => {
    const t = holding?.targets ?? [];
    return t.length === 1 ? `“${t[0]!.title}”` : `${t.length} chats`;
  });

  // Each opening starts afresh (from the chat's current hold, when it has one).
  $effect(() => {
    const h = holding;
    if (!h) return;
    now = Date.now();
    error = null;
    busy = false;
    const only = h.targets.length === 1 ? h.targets[0] : undefined;
    const held = only?.bucket === 'onHold';
    note = held ? (only.holdNote ?? '') : '';
    if (held && only.holdUntil !== undefined) {
      choice = 'pick';
      picked = toDateTimeLocal(only.holdUntil);
    } else {
      choice = held ? 'none' : 'tomorrow';
      picked = '';
    }
  });

  /** The chosen end of the hold; null while "Pick" has no valid time ahead. */
  const until = $derived.by((): number | undefined | null => {
    if (choice === 'tomorrow') return presets.tomorrow;
    if (choice === 'nextWeek') return presets.nextWeek;
    if (choice === 'none') return undefined;
    const t = fromDateTimeLocal(picked);
    return t !== null && t > now ? t : null;
  });
  const problem = $derived(choice === 'pick' ? pickProblem(picked, now) : null);

  const day = (t: number): string =>
    new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const save = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    // The dialog may have stayed open a while (past midnight: "Tomorrow" moved on).
    now = Date.now();
    if (until === null || busy) return;
    busy = true;
    error = null;
    try {
      await buckets.saveHold({ until, note });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };

  const optionClass =
    'hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm';
</script>

<Dialog.Root
  open={holding !== null}
  onOpenChange={(open) => {
    if (!open) buckets.closeHold();
  }}
>
  <Dialog.Content showCloseButton={false} class="gap-4 p-5 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="text-base">Put on hold</Dialog.Title>
      <Dialog.Description class="truncate text-sm">{subject}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={save}>
      <fieldset class="flex flex-col gap-0.5">
        <legend class="text-muted-foreground mb-1 text-xs font-medium">Until</legend>
        <label class={optionClass}>
          <input type="radio" name="hold-until" value="tomorrow" bind:group={choice} />
          <span class="flex-1">Tomorrow 09:00</span>
          <span class="text-muted-foreground text-xs">{day(presets.tomorrow)}</span>
        </label>
        <label class={optionClass}>
          <input type="radio" name="hold-until" value="nextWeek" bind:group={choice} />
          <span class="flex-1">Next week (Monday 09:00)</span>
          <span class="text-muted-foreground text-xs">{day(presets.nextWeek)}</span>
        </label>
        <label class={optionClass}>
          <input type="radio" name="hold-until" value="pick" bind:group={choice} />
          <span class="flex-1">Pick date &amp; time</span>
          {#if choice === 'pick' && until}
            <span class="text-muted-foreground text-xs">{formatHoldUntil(until, now)}</span>
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
        <label class={optionClass}>
          <input type="radio" name="hold-until" value="none" bind:group={choice} />
          <span class="flex-1">No date</span>
        </label>
      </fieldset>
      <label class="flex flex-col gap-1">
        <span class="text-muted-foreground text-xs font-medium">Note (optional)</span>
        <input
          type="text"
          maxlength={HOLD_NOTE_MAX}
          placeholder="Waiting for review from Petr"
          class="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2"
          bind:value={note}
        />
      </label>
      {#if error}
        <p class="text-destructive text-sm" role="alert">{error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" size="sm" onclick={() => buckets.closeHold()}
          >Cancel</Button
        >
        <Button type="submit" size="sm" disabled={busy || until === null}>Save</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

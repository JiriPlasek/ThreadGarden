<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
  import InfoIcon from '@lucide/svelte/icons/info';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  /**
   * A system message (info / warning / error); long text is clamped until
   * expanded. An item with `detail` (Ruling R27: a notification or hand-back
   * the CLI injected as a user turn) shows its short label, the full text on demand.
   */
  let { item }: { item: Extract<ChatItem, { kind: 'system' }> } = $props();

  const LONG = 600;
  let expanded = $state(false);
  let detailOpen = $state(false);
  const long = $derived(item.text.length > LONG);
  const shown = $derived(long && !expanded ? `${item.text.slice(0, LONG)}…` : item.text);
  const tone = $derived(
    item.level === 'error'
      ? 'border-destructive/40 bg-destructive/5 text-destructive'
      : item.level === 'warning'
        ? 'border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200'
        : 'text-muted-foreground',
  );
</script>

<div
  class="flex items-start gap-2 rounded-md border px-3 py-1.5 text-xs {tone}"
  role={item.level === 'error' ? 'alert' : 'note'}
>
  {#if item.level === 'error'}
    <CircleAlertIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
  {:else if item.level === 'warning'}
    <TriangleAlertIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
  {:else}
    <InfoIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
  {/if}
  <div class="min-w-0 flex-1">
    <div class="break-words whitespace-pre-wrap">{shown}</div>
    {#if long}
      <button
        type="button"
        class="mt-0.5 underline-offset-2 hover:underline"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}>{expanded ? 'Show less' : 'Show all'}</button
      >
    {/if}
    {#if item.detail !== undefined}
      <button
        type="button"
        class="mt-0.5 underline-offset-2 hover:underline"
        aria-expanded={detailOpen}
        onclick={() => (detailOpen = !detailOpen)}
        >{detailOpen ? 'Hide details' : 'Show details'}</button
      >
      {#if detailOpen}
        <div class="mt-1 max-h-80 overflow-y-auto border-t pt-1 break-words whitespace-pre-wrap">
          {item.detail}
        </div>
      {/if}
    {/if}
  </div>
</div>

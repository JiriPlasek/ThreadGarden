<script lang="ts">
  import type { Snippet } from 'svelte';
  import { prettyJson } from '../tools';
  import { reportUiError } from '#lib/ui-error-reporter.js';

  /**
   * Error boundary around one chat item (spec §7): a renderer bug shows a
   * "couldn't be displayed — show raw" note instead of taking the chat down.
   * A newer version of the item gets a fresh attempt.
   */
  let { item, children }: { item: unknown; children: Snippet } = $props();

  let showRaw = $state(false);
  let retry: (() => void) | null = null;

  $effect(() => {
    void item;
    const r = retry;
    retry = null;
    r?.();
  });

  const onFailed = (error: unknown, reset: () => void): void => {
    retry = reset;
    reportUiError('item', error);
  };
</script>

<svelte:boundary onerror={onFailed}>
  {@render children()}

  {#snippet failed()}
    <div
      class="text-muted-foreground rounded-md border border-dashed px-3 py-1.5 text-xs"
      role="note"
    >
      <div class="flex items-center gap-2">
        <span>This item couldn't be displayed.</span>
        <button
          type="button"
          class="text-foreground underline-offset-2 hover:underline"
          aria-expanded={showRaw}
          onclick={() => (showRaw = !showRaw)}>{showRaw ? 'Hide raw' : 'Show raw'}</button
        >
      </div>
      {#if showRaw}
        <pre
          class="bg-muted mt-1.5 max-h-80 overflow-auto rounded p-2 font-mono text-[0.6875rem] leading-snug">{prettyJson(
            item,
          )}</pre>
      {/if}
    </div>
  {/snippet}
</svelte:boundary>

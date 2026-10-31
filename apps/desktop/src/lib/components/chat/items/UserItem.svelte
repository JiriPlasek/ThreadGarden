<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import GitForkIcon from '@lucide/svelte/icons/git-fork';
  import { chatActions } from '../context';

  /**
   * A user message. Top-level messages offer "Fork from this message" (spec §6.4);
   * very long pastes are clamped until expanded.
   */
  let { item, nested = false }: { item: Extract<ChatItem, { kind: 'user' }>; nested?: boolean } =
    $props();

  const actions = chatActions();
  const LONG = 3000;
  let expanded = $state(false);
  const long = $derived(item.text.length > LONG);
  const shown = $derived(long && !expanded ? `${item.text.slice(0, LONG)}…` : item.text);
</script>

<div class="group bg-muted/70 relative rounded-lg px-3 py-2 text-sm">
  {#if item.text}
    <div class="pr-6 break-words whitespace-pre-wrap">{shown}</div>
  {/if}
  {#if long}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground mt-1 text-xs underline-offset-2 hover:underline"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
      >{expanded ? 'Show less' : `Show all ${item.text.length.toLocaleString()} characters`}</button
    >
  {/if}
  {#if item.images?.length}
    <div class="mt-1.5 flex flex-wrap gap-1.5">
      {#each item.images as img, i (i)}
        <img
          src="data:{img.mediaType};base64,{img.data}"
          alt="Attached image {i + 1}"
          class="max-h-32 max-w-48 rounded border object-contain"
        />
      {/each}
    </div>
  {/if}
  {#if !nested && actions.fork}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground hover:bg-background absolute top-1.5 right-1.5 rounded p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      aria-label="Fork from this message"
      title="Fork from this message"
      onclick={() => actions.fork?.(item.id)}
    >
      <GitForkIcon class="size-4" aria-hidden="true" />
    </button>
  {/if}
</div>

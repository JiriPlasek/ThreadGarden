<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import GitForkIcon from '@lucide/svelte/icons/git-fork';
  import { imageCountText } from '#lib/format/images.js';
  import { isThreadgardenNote } from '#lib/move/note.js';
  import { chatActions } from '../context';
  import UserText from './UserText.svelte';
  import Attachments from '../../composer/Attachments.svelte';
  import { activePastes, restoreMessage } from '../../composer/tags';

  /**
   * A user message. Top-level messages offer "Fork from this message" (spec §6.4);
   * very long pastes are clamped until expanded. Threadgarden's own note in a
   * moved chat (ruling R4) is labelled, so it doesn't read as the owner's words.
   * A message read from an away machine's copy has no images, only how many
   * it had (`imageCount`), which is said instead.
   */
  let {
    item,
    nested = false,
  }: {
    item: Extract<ChatItem, { kind: 'user' }> & { imageCount?: number };
    nested?: boolean;
  } = $props();

  const actions = chatActions();
  const LONG = 3000;
  let expanded = $state(false);
  const message = $derived(restoreMessage(item.text));
  const display = $derived(message.text);
  const pastes = $derived(activePastes(message.text, message.attachments));
  const long = $derived(display.length > LONG);
  const fromThreadgarden = $derived(isThreadgardenNote(item.text));
</script>

<div class="group bg-muted/70 relative rounded-lg px-3 py-2 text-sm">
  {#if fromThreadgarden}
    <div class="text-muted-foreground mb-1 text-[0.6875rem] font-medium">Sent by Threadgarden</div>
  {/if}
  {#if item.text}
    <UserText text={item.text} images={item.images} limit={long && !expanded ? LONG : undefined} />
  {/if}
  {#if long}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground mt-1 text-xs underline-offset-2 hover:underline"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
      >{expanded ? 'Show less' : `Show all ${display.length.toLocaleString()} characters`}</button
    >
  {/if}
  {#if item.images?.length || pastes.length}
    <div class="mt-1.5">
      <Attachments
        images={item.images ?? []}
        numbers={item.images?.map((image, i) => image.number ?? i + 1)}
        {pastes}
      />
    </div>
  {/if}
  {#if !item.images?.length && item.imageCount}
    <div class="text-muted-foreground mt-1 text-xs">{imageCountText(item.imageCount)}</div>
  {/if}
  {#if !nested && actions.fork && !fromThreadgarden}
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

<script lang="ts">
  import { tick } from 'svelte';
  import WandIcon from '@lucide/svelte/icons/wand-sparkles';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import type { ChatSummary } from '@threadgarden/protocol';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';

  /**
   * Renames a chat in Threadgarden only (spec §5.3: Claude Code's own data is never
   * changed). An empty title restores the original one.
   */
  let {
    chat,
    onSubmit,
    onSuggest,
    onClose,
  }: {
    chat: ChatSummary | null;
    onSubmit: (sessionId: string, title: string | null) => Promise<void>;
    onSuggest?: (sessionId: string) => Promise<string>;
    onClose: () => void;
  } = $props();

  let value = $state('');
  let busy = $state(false);
  let suggesting = $state(false);
  let generation = 0;
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    generation++;
    suggesting = false;
    if (chat) {
      value = chat.title;
      error = null;
      queueMicrotask(() => input?.select());
    }
  });

  const suggest = async (): Promise<void> => {
    if (!chat || !onSuggest || busy || suggesting) return;
    const target = chat;
    const request = ++generation;
    suggesting = true;
    error = null;
    try {
      const title = await onSuggest(target.sessionId);
      if (generation !== request || chat !== target) return;
      value = title;
      suggesting = false;
      await tick();
      if (generation !== request || chat !== target) return;
      input?.focus();
      input?.select();
    } catch (err) {
      if (generation === request) error = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === request) suggesting = false;
    }
  };

  const submit = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (!chat || busy || suggesting) return;
    busy = true;
    error = null;
    try {
      await onSubmit(chat.sessionId, value.trim() || null);
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };
</script>

<Dialog.Root open={chat !== null} onOpenChange={(open) => !open && onClose()}>
  <Dialog.Content class="gap-4 p-5 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="text-base">Rename chat</Dialog.Title>
      <Dialog.Description class="text-xs">
        The new title is stored in Threadgarden only. Leave it empty to use the original title.
      </Dialog.Description>
    </Dialog.Header>
    <form class="grid gap-3" onsubmit={submit}>
      <div class="flex items-center gap-1.5">
        <input
          bind:this={input}
          bind:value
          aria-label="Chat title"
          disabled={busy || suggesting}
          class="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3"
        />
        {#if onSuggest}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Suggest chat name"
            title="Suggest a name from the conversation"
            aria-busy={suggesting}
            disabled={busy || suggesting}
            onclick={suggest}
          >
            {#if suggesting}<LoaderCircleIcon class="animate-spin" />{:else}<WandIcon />{/if}
          </Button>
        {/if}
      </div>
      {#if error}<p class="text-destructive text-xs" role="alert">{error}</p>{/if}
      <Dialog.Footer>
        <Button variant="outline" size="sm" onclick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || suggesting}>Rename</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

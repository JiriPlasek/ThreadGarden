<script lang="ts">
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
    onClose,
  }: {
    chat: ChatSummary | null;
    onSubmit: (sessionId: string, title: string | null) => Promise<void>;
    onClose: () => void;
  } = $props();

  let value = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (chat) {
      value = chat.title;
      error = null;
      queueMicrotask(() => input?.select());
    }
  });

  const submit = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    if (!chat) return;
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
      <input
        bind:this={input}
        bind:value
        aria-label="Chat title"
        class="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3"
      />
      {#if error}<p class="text-destructive text-xs" role="alert">{error}</p>{/if}
      <Dialog.Footer>
        <Button variant="outline" size="sm" onclick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>Rename</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

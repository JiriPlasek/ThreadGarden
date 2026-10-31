<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import HoldDialog from '#lib/components/HoldDialog.svelte';
  import { ARCHIVE_OLDER_DAYS } from '#lib/state/buckets.svelte.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * The dialogs of moving chats between buckets (v1.2 §3), hosted once by the
   * app shell for the chat list, the chat header and the quick switcher: the
   * hold popover, "End this chat and archive it?", the archive-older
   * confirmation, and a notice (a toast) for what the service skipped.
   */
  const { buckets } = useApp();

  /** A notice goes away by itself after this long (or with its close button). */
  const NOTICE_MS = 10_000;

  // Kept while the dialogs close, so their text does not blank out mid-animation.
  let endingTitle = $state('');
  let olderCount = $state(0);
  $effect(() => {
    if (buckets.ending) endingTitle = buckets.ending.title;
  });
  $effect(() => {
    if (buckets.archivingOlder) olderCount = buckets.archivingOlder.count;
  });
  $effect(() => {
    if (!buckets.notice) return;
    const t = setTimeout(() => buckets.dismissNotice(), NOTICE_MS);
    return () => clearTimeout(t);
  });

  const chatsWord = (n: number): string => (n === 1 ? '1 chat' : `${n} chats`);
</script>

<HoldDialog />

<ConfirmDialog
  bind:open={
    () => buckets.ending !== null,
    (open) => {
      if (!open) buckets.cancelEnding();
    }
  }
  title="End this chat and archive it?"
  description="pahub is running “{endingTitle}”. Ending stops its Claude Code process; the chat stays in your history, in Archived, and returns to Active when you send it a message."
  confirmLabel="End and archive"
  destructive
  onConfirm={buckets.endAndArchive}
/>

<ConfirmDialog
  bind:open={
    () => buckets.archivingOlder !== null,
    (open) => {
      if (!open) buckets.cancelArchiveOlder();
    }
  }
  title="Archive {chatsWord(olderCount)} older than {ARCHIVE_OLDER_DAYS} days?"
  description="Chats that are running, wait for you, are unread or back from hold stay in Active. An archived chat returns to Active when it runs again or you send it a message."
  confirmLabel="Archive {chatsWord(olderCount)}"
  onConfirm={buckets.archiveOlder}
/>

<!-- Always in the DOM, so screen readers announce what appears in it. -->
<div
  role="status"
  class="pointer-events-none fixed inset-x-0 bottom-12 z-50 flex justify-center px-4"
>
  {#if buckets.notice}
    <div
      class="bg-popover text-popover-foreground ring-foreground/10 pointer-events-auto flex max-w-lg items-start gap-2 rounded-md px-3 py-2 text-sm shadow-md ring-1"
    >
      <p class="min-w-0 flex-1">{buckets.notice}</p>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground -mr-1 shrink-0 rounded p-0.5"
        aria-label="Dismiss"
        onclick={() => buckets.dismissNotice()}
      >
        <XIcon class="size-4" aria-hidden="true" />
      </button>
    </div>
  {/if}
</div>

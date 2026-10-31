<script lang="ts">
  import type { ChatTask } from '@pahub/protocol';
  import XIcon from '@lucide/svelte/icons/x';
  import { endSessionWarning } from '#lib/components/chat/end-session.js';
  import RunningTaskList from '#lib/components/chat/RunningTaskList.svelte';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import HoldDialog from '#lib/components/HoldDialog.svelte';
  import { ARCHIVE_OLDER_DAYS } from '#lib/state/buckets.svelte.js';
  import { taskRunning } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * The dialogs of moving chats between buckets (v1.2 §3), hosted once by the
   * app shell for the chat list, the chat header and the quick switcher: the
   * hold popover, "End this chat and archive it?", the archive-older
   * confirmation, and a notice (a toast) for what the service skipped.
   */
  const { buckets, chats } = useApp();

  /** A notice goes away by itself after this long (or with its close button). */
  const NOTICE_MS = 10_000;

  const ARCHIVE_AFTER =
    'the chat stays in your history, in Archived, and returns to Active when you send it a message.';

  /**
   * What ending the chat stops, worded as End session does (its running turn,
   * its background tasks): from the open chat when it is loaded (tasks listed),
   * else from its summary (tasks counted).
   */
  const endingInfo = $derived.by(() => {
    const t = buckets.ending;
    if (!t) return null;
    const chat = chats.get(t.sessionId);
    const loaded = !!chat?.loaded;
    const status = loaded ? chat!.status : t.status;
    const tasks: ChatTask[] = loaded ? chat!.tasks.filter(taskRunning) : [];
    const busy = status === 'working' || status === 'needsYou';
    const warning = endSessionWarning({
      busy,
      tasks: loaded ? tasks.length : (t.runningTasks ?? 0),
      listed: loaded,
      after: ARCHIVE_AFTER,
    });
    return {
      tasks,
      description:
        warning ??
        `Threadgarden is running “${t.title}”. Ending stops its Claude Code process; ${ARCHIVE_AFTER}`,
    };
  });

  // Kept while the dialogs close, so their text does not blank out mid-animation.
  let endingDescription = $state('');
  let endingTasks = $state.raw<ChatTask[]>([]);
  let olderCount = $state(0);
  $effect(() => {
    if (!endingInfo) return;
    endingDescription = endingInfo.description;
    endingTasks = endingInfo.tasks;
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
  description={endingDescription}
  confirmLabel="End and archive"
  destructive
  onConfirm={buckets.endAndArchive}
>
  <RunningTaskList tasks={endingTasks} />
</ConfirmDialog>

<ConfirmDialog
  bind:open={
    () => buckets.archivingOlder !== null,
    (open) => {
      if (!open) buckets.cancelArchiveOlder();
    }
  }
  title="Archive {chatsWord(olderCount)} older than {ARCHIVE_OLDER_DAYS} days?"
  description="Pinned chats, and chats that are running, wait for you, are unread or back from hold, stay in Active. An archived chat returns to Active when it runs again or you send it a message."
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

<script lang="ts">
  import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
  import { useApp } from '#lib/state/context.js';
  import { baseName, modKey, rawStatus, tabId } from './chat-info';
  import StatusIcon from './StatusIcon.svelte';

  /** The right column's content for the active tab (the chat view itself replaces the body). */
  const { tabs, chats, places } = useApp();

  const chat = $derived(tabs.active ? chats.get(tabs.active) : undefined);
  const summary = $derived(chat?.summary ?? null);
  const project = $derived(
    summary
      ? (places.projects.find((p) => p.projectId === summary.projectId)?.displayName ??
          baseName(summary.cwd))
      : '',
  );
</script>

{#if tabs.active}
  <div
    role="tabpanel"
    id="chat-panel"
    aria-labelledby={tabId(tabs.active)}
    tabindex="-1"
    class="flex min-h-0 flex-1 flex-col outline-none"
  >
    <header class="flex h-10 shrink-0 items-center gap-2 border-b px-4">
      {#if chat?.loaded}
        <StatusIcon status={chat.status} raw={rawStatus(summary)} />
      {/if}
      <h1 class="min-w-0 truncate text-sm font-semibold">{summary?.title ?? 'Loading…'}</h1>
      {#if project}
        <span class="text-muted-foreground shrink-0 text-xs">{project}</span>
      {/if}
    </header>
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      {#if chat?.error}
        <p class="text-destructive text-sm" role="alert">Could not open this chat: {chat.error}</p>
      {:else if !chat?.loaded}
        <p class="text-muted-foreground text-sm" role="status">Loading…</p>
      {/if}
    </div>
  </div>
{:else}
  <div class="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
    <MessagesSquareIcon class="size-8 opacity-40" aria-hidden="true" />
    <p class="text-sm">Select a chat or press {modKey()}K</p>
  </div>
{/if}

<script lang="ts">
  import { useApp } from '#lib/state/context.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessageList from './MessageList.svelte';

  /** One open chat: header with controls, then the virtualised messages. */
  let { sessionId }: { sessionId: string } = $props();

  const { chats, tabs } = useApp();
  const chat = $derived(chats.get(sessionId));

  let forkError = $state<string | null>(null);

  const fork = (itemId: string): void => {
    forkError = null;
    chats
      .fork(sessionId, itemId)
      .then((id) => tabs.openTab(id))
      .catch((err: unknown) => {
        forkError = err instanceof Error ? err.message : String(err);
      });
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if chat}
    <ChatHeader {chat} />
  {/if}
  {#if forkError}
    <div class="bg-destructive/10 text-destructive shrink-0 px-4 py-1 text-xs" role="alert">
      {forkError}
    </div>
  {/if}
  {#if chat?.error && !chat.loaded}
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <p class="text-destructive text-sm" role="alert">Could not open this chat: {chat.error}</p>
    </div>
  {:else if !chat?.loaded}
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <p class="text-muted-foreground text-sm" role="status">Loading…</p>
    </div>
  {:else}
    {#if chat.error}
      <div class="bg-destructive/10 text-destructive shrink-0 px-4 py-1 text-xs" role="alert">
        {chat.error}
      </div>
    {/if}
    {#if chat.items.length === 0}
      <div class="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm">
        No messages yet.
      </div>
    {:else}
      <MessageList
        items={chat.items}
        hasMore={chat.hasMore}
        loadingOlder={chat.loadingOlder}
        onLoadOlder={() => void chats.loadOlder(sessionId)}
        onFork={fork}
        memory={chat.view}
      />
    {/if}
  {/if}
</div>

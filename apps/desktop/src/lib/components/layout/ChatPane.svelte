<script lang="ts">
  import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
  import ChatView from '#lib/components/chat/ChatView.svelte';
  import { useApp } from '#lib/state/context.js';
  import { modKey, tabId } from './chat-info';

  /** The right column's content: the active tab's chat. */
  const { tabs } = useApp();
</script>

{#if tabs.active}
  <div
    role="tabpanel"
    id="chat-panel"
    aria-labelledby={tabId(tabs.active)}
    tabindex="-1"
    class="flex min-h-0 flex-1 flex-col outline-none"
  >
    {#key tabs.active}
      <ChatView sessionId={tabs.active} />
    {/key}
  </div>
{:else}
  <div class="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
    <MessagesSquareIcon class="size-8 opacity-40" aria-hidden="true" />
    <p class="text-sm">Select a chat or press {modKey()}K</p>
  </div>
{/if}

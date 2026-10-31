<script lang="ts">
  import BucketDialogs from '../../src/lib/components/BucketDialogs.svelte';
  import ChatHeader from '../../src/lib/components/chat/ChatHeader.svelte';
  import ChatList from '../../src/lib/components/layout/ChatList.svelte';
  import type { ChatState } from '../../src/lib/state/chats.svelte';

  /** The chat list (or a chat's header) plus the bucket dialogs the app shell hosts. */
  let { chat }: { chat?: ChatState } = $props();
</script>

{#if chat}
  <ChatHeader {chat} />
{:else}
  <ChatList />
{/if}
<BucketDialogs />

<script lang="ts">
  import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
  import AnalyticsView from '#lib/components/analytics/AnalyticsView.svelte';
  import ChatView from '#lib/components/chat/ChatView.svelte';
  import InScope from '#lib/components/InScope.svelte';
  import { useApp } from '#lib/state/context.js';
  import { parseChatKey } from '#lib/state/refs.js';
  import { formatShortcut, shortcut } from '#lib/shortcuts.js';
  import { ANALYTICS_TAB_ID, tabId } from './chat-info';

  /**
   * The right column's content: the active tab's chat, shown inside its
   * machine's scope, or (v1.3) the Analytics view. A tab of a machine whose
   * scope is not there yet (restored before the machine is known) stays empty.
   */
  const { tabs, scopes } = useApp();
  const ref = $derived(tabs.active ? parseChatKey(tabs.active) : null);
  const scope = $derived(ref ? scopes.get(ref.machineId) : undefined);
</script>

{#if tabs.analyticsShown}
  <div
    role="tabpanel"
    id="chat-panel"
    aria-labelledby={ANALYTICS_TAB_ID}
    tabindex="-1"
    class="flex min-h-0 flex-1 flex-col outline-none"
  >
    <AnalyticsView />
  </div>
{:else if tabs.active}
  <div
    role="tabpanel"
    id="chat-panel"
    aria-labelledby={tabId(tabs.active)}
    tabindex="-1"
    class="flex min-h-0 flex-1 flex-col outline-none"
  >
    {#key tabs.active}
      {#if ref && scope}
        {#key scope}
          <InScope {scope}>
            <ChatView {ref} />
          </InScope>
        {/key}
      {/if}
    {/key}
  </div>
{:else}
  <div class="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
    <MessagesSquareIcon class="size-8 opacity-40" aria-hidden="true" />
    <p class="text-sm">
      Select a chat or press {formatShortcut(shortcut('quick-switcher').combos[0]!)}
    </p>
    <p class="text-xs">
      {formatShortcut(shortcut('shortcuts').combos[0]!)} shows every keyboard shortcut
    </p>
  </div>
{/if}

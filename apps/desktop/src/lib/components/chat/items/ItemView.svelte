<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import AssistantText from './AssistantText.svelte';
  import ItemBoundary from './ItemBoundary.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import PlanApproval from './PlanApproval.svelte';
  import QuestionForm from './QuestionForm.svelte';
  import ResultFooter from './ResultFooter.svelte';
  import SystemNotice from './SystemNotice.svelte';
  import Thinking from './Thinking.svelte';
  import TodoList from './TodoList.svelte';
  import ToolCallRow from './ToolCallRow.svelte';
  import UnknownItem from './UnknownItem.svelte';
  import UserItem from './UserItem.svelte';

  /**
   * Renders one chat item by kind, inside its own error boundary. A kind this UI
   * does not know (a newer service) falls back to the raw "unrecognised" view.
   */
  let {
    item,
    children,
    nested = false,
  }: { item: ChatItem; children?: ChatItem[]; nested?: boolean } = $props();

  const raw = $derived(item as unknown as { id?: unknown; kind?: unknown });
</script>

<div data-item-id={item.id}>
  <ItemBoundary {item}>
    {#if item.kind === 'user'}
      <UserItem {item} {nested} />
    {:else if item.kind === 'assistantText'}
      <AssistantText {item} />
    {:else if item.kind === 'thinking'}
      <Thinking {item} />
    {:else if item.kind === 'toolCall'}
      <ToolCallRow {item} {children} />
    {:else if item.kind === 'todo'}
      <TodoList {item} />
    {:else if item.kind === 'permissionRequest'}
      {#if item.variant === 'question'}
        <QuestionForm {item} />
      {:else if item.variant === 'plan'}
        <PlanApproval {item} />
      {:else}
        <PermissionCard {item} />
      {/if}
    {:else if item.kind === 'system'}
      <SystemNotice {item} />
    {:else if item.kind === 'compactBoundary'}
      <div class="text-muted-foreground flex items-center gap-2 text-[11px]" role="separator">
        <span class="bg-border h-px flex-1" aria-hidden="true"></span>
        <span>Conversation compacted</span>
        <span class="bg-border h-px flex-1" aria-hidden="true"></span>
      </div>
    {:else if item.kind === 'result'}
      <ResultFooter {item} />
    {:else if item.kind === 'unknown'}
      <UnknownItem items={[item]} />
    {:else}
      <UnknownItem items={[{ id: String(raw.id), sdkType: String(raw.kind), raw: item }]} />
    {/if}
  </ItemBoundary>
</div>

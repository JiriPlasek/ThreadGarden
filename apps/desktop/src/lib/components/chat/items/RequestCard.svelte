<script lang="ts">
  import HandIcon from '@lucide/svelte/icons/hand';
  import { chatActions } from '../context';
  import PermissionCard from './PermissionCard.svelte';
  import PlanApproval from './PlanApproval.svelte';
  import QuestionForm from './QuestionForm.svelte';
  import { requestWhat, type RequestItem } from './requests';

  /**
   * A permission request, question or plan approval. While one waits in a chat
   * where it can be answered, its card takes the composer's place at the bottom
   * (ChatView renders it `docked`), as in the terminal, and the list keeps one
   * line where Claude asked. Answered, or where it cannot be answered here (a
   * machine that went off), the list shows the card itself.
   */
  let { item, docked = false }: { item: RequestItem; docked?: boolean } = $props();

  const actions = chatActions();
  const elsewhere = $derived(actions.requests !== undefined && actions.requestsDocked === true);
</script>

{#if item.state === 'pending' && elsewhere && !docked}
  <div
    class="flex items-center gap-2 rounded-md bg-amber-500/5 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200"
    role="status"
    data-waiting-request={item.requestId}
  >
    <HandIcon class="size-4 shrink-0" aria-hidden="true" />
    <span class="shrink-0 font-medium">Waiting for your answer below</span>
    <span class="text-muted-foreground min-w-0 truncate">{requestWhat(item)}</span>
  </div>
{:else if item.variant === 'question'}
  <QuestionForm {item} />
{:else if item.variant === 'plan'}
  <PlanApproval {item} />
{:else}
  <PermissionCard {item} />
{/if}

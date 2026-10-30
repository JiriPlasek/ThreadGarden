<script lang="ts">
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
  import type { Decision } from '#lib/state/chats.svelte.js';
  import { requestWhat, settledLabel, type RequestItem } from './requests';

  /**
   * A permission request, question or plan approval after it was answered (or
   * cancelled): one line with its final state, plus the answers given here.
   */
  let { item, decision }: { item: RequestItem; decision?: Decision } = $props();

  const label = $derived(settledLabel(item, decision?.decision));
  const answers = $derived(Object.entries(decision?.answers ?? {}));
</script>

<div
  class="text-muted-foreground rounded-md border px-3 py-1.5 text-xs"
  role="group"
  aria-label="{item.variant === 'plan'
    ? 'Plan approval'
    : item.variant === 'question'
      ? 'Question'
      : 'Permission request'}: {label}"
  data-request-id={item.requestId}
>
  <div class="flex items-center gap-2">
    {#if item.state === 'allowed'}
      <CircleCheckIcon class="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
    {:else}
      <CircleSlashIcon class="size-3.5 shrink-0" aria-hidden="true" />
    {/if}
    <span class="text-foreground shrink-0 font-medium">{label}</span>
    <span class="min-w-0 truncate">{requestWhat(item)}</span>
  </div>
  {#if answers.length > 0}
    <dl class="mt-1 space-y-0.5 pl-5">
      {#each answers as [question, answer] (question)}
        <div class="flex gap-1.5">
          <dt class="min-w-0 truncate">{question}</dt>
          <dd class="text-foreground shrink-0">{answer}</dd>
        </div>
      {/each}
    </dl>
  {/if}
</div>

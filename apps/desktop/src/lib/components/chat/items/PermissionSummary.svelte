<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
  import HandIcon from '@lucide/svelte/icons/hand';
  import { summarize } from '../tools';

  /**
   * Read-only summary of a permission request, question or plan approval. The
   * interactive cards (spec §6.4 "Controls") replace this component.
   */
  let { item }: { item: Extract<ChatItem, { kind: 'permissionRequest' }> } = $props();

  const what = $derived.by(() => {
    if (item.variant === 'question') return 'a question';
    if (item.variant === 'plan') return 'plan approval';
    const s = summarize({
      kind: 'toolCall',
      id: item.id,
      toolUseId: item.requestId,
      name: item.toolName,
      input: item.input,
      status: 'running',
      parentToolUseId: null,
    });
    return s.target ? `${item.toolName} · ${s.target}` : item.toolName;
  });
  const label = $derived(
    item.state === 'pending'
      ? item.variant === 'tool'
        ? `Waiting for permission: ${what}`
        : `Waiting for you: ${what}`
      : `${{ allowed: 'Allowed', denied: 'Denied', cancelled: 'Cancelled' }[item.state]}: ${what}`,
  );
</script>

<div
  class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs {item.state === 'pending'
    ? 'border-amber-500/50 bg-amber-500/5 text-amber-900 dark:text-amber-200'
    : 'text-muted-foreground'}"
  role="status"
>
  {#if item.state === 'pending'}
    <HandIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {:else if item.state === 'allowed'}
    <CircleCheckIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {:else}
    <CircleSlashIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {/if}
  <span class="truncate">{label}</span>
</div>

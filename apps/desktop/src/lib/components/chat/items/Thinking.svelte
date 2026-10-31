<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

  /** A thinking block, collapsed by default (spec §6.4). */
  let { item }: { item: Extract<ChatItem, { kind: 'thinking' }> } = $props();

  let open = $state(false);
  const text = $derived(item.text.trim());
  const preview = $derived(text.split('\n', 1)[0] ?? '');
</script>

<div class="text-muted-foreground text-xs">
  <button
    type="button"
    class="hover:text-foreground flex max-w-full items-center gap-1.5 rounded py-0.5 text-left"
    aria-expanded={open}
    disabled={!text}
    onclick={() => (open = !open)}
  >
    <ChevronRightIcon
      class="size-4 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
      aria-hidden="true"
    />
    <span class="font-medium">Thinking</span>
    {#if !text}
      <span class="italic opacity-80">(not shown)</span>
    {:else if !open}
      <span class="truncate italic opacity-80">{preview}</span>
    {/if}
  </button>
  {#if open && text}
    <div class="mt-1 ml-1.5 border-l pl-3 leading-relaxed break-words whitespace-pre-wrap italic">
      {item.text}
    </div>
  {/if}
</div>

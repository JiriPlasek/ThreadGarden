<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';

  let {
    children,
    initialScroll = 0,
    onScroll,
    revealKey,
  }: {
    children: Snippet;
    initialScroll?: number;
    onScroll: (top: number) => void;
    revealKey?: string;
  } = $props();
  const restoredScroll = untrack(() => initialScroll);
  let viewport = $state<HTMLDivElement | null>(null);
  let body = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (!viewport || !body) return;
    viewport.scrollTop = restoredScroll;
  });
  $effect(() => {
    if (!revealKey || !viewport || !body) return;
    const target = Array.from(body.children).find(
      (child) => (child as HTMLElement).dataset.conciseItem === revealKey,
    );
    if (target) {
      viewport.scrollTop +=
        target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    }
  });
</script>

<div>
  <!-- The scroll region must be focusable so keyboard users can scroll a long turn. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={viewport}
    data-turn-scroll
    role="region"
    aria-label="AI response"
    tabindex="0"
    class="max-h-80 overflow-x-hidden overflow-y-auto focus-visible:outline focus-visible:outline-ring"
    onscroll={() => {
      if (viewport) onScroll(viewport.scrollTop);
    }}
  >
    <div bind:this={body} class="space-y-2">{@render children()}</div>
  </div>
</div>

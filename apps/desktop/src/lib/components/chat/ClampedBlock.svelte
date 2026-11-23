<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    children,
    expanded,
    onToggle,
  }: {
    children: Snippet;
    expanded: boolean;
    onToggle: (value: boolean) => void;
  } = $props();
  const contentId = $props.id();
  let clip = $state<HTMLDivElement | null>(null);
  let body = $state<HTMLDivElement | null>(null);
  let overflow = $state(false);
  $effect(() => {
    const outer = clip;
    const inner = body;
    const open = expanded;
    if (!outer || !inner) return;
    const measure = (): void => {
      overflow = open || inner.scrollHeight > outer.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  });
</script>

<div data-concise-block>
  <div
    bind:this={clip}
    id={contentId}
    class="overflow-hidden"
    style:max-height={expanded ? undefined : '20rem'}
    onfocusin={() => {
      // Keyboard focus must never land on an interactive control hidden by clipping.
      if (!expanded && overflow) onToggle(true);
    }}
  >
    <div bind:this={body} data-clamped-content>{@render children()}</div>
  </div>
  {#if expanded || overflow}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground mt-1 rounded px-1 py-0.5 text-xs underline underline-offset-2"
      aria-expanded={expanded}
      aria-controls={contentId}
      onclick={() => onToggle(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button
    >
  {/if}
</div>

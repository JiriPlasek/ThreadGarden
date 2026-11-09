<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  let {
    image,
    text,
    missing = false,
    label,
    left,
    top,
    onmouseenter,
    onmouseleave,
    scrollElement = $bindable(null),
    element = $bindable(null),
  }: {
    image?: ImageRef;
    text?: string;
    missing?: boolean;
    label: string;
    left: number;
    top: number;
    onmouseenter?: () => void;
    onmouseleave?: () => void;
    scrollElement?: HTMLPreElement | null;
    element?: HTMLDivElement | null;
  } = $props();
</script>

<div
  bind:this={element}
  data-attachment-preview
  role="tooltip"
  aria-label={label}
  {onmouseenter}
  {onmouseleave}
  class="bg-popover text-popover-foreground fixed z-[100] max-h-80 w-80 overflow-auto rounded-md border p-2 text-xs shadow-lg"
  style:left="{Math.max(8, Math.min(left, window.innerWidth - 328))}px"
  style:top="{Math.max(8, top < 320 ? top + 30 : top)}px"
  style:transform={top < 320 ? undefined : 'translateY(-100%)'}
>
  {#if image}
    <img
      src="data:{image.mediaType};base64,{image.data}"
      alt={label}
      class="max-h-72 max-w-full object-contain"
    />
  {:else if missing}
    <p>This image wasn't kept; attach it again.</p>
  {:else}
    <pre
      bind:this={scrollElement}
      class="max-h-72 overflow-auto font-mono whitespace-pre-wrap">{text}</pre>
  {/if}
</div>

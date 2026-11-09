<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import { previewPosition } from './preview-position';
  let {
    image,
    text,
    missing = false,
    label,
    left,
    top,
    anchor,
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
    anchor?: HTMLElement;
    onmouseenter?: () => void;
    onmouseleave?: () => void;
    scrollElement?: HTMLPreElement | null;
    element?: HTMLDivElement | null;
  } = $props();

  // Fixed descendants of a transformed virtual-list row are not viewport-fixed.
  // Keep the preview in the body so list clipping and row transforms cannot move it.
  const portal = (node: HTMLDivElement) => {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  };
  $effect(() => {
    const node = element;
    const target = anchor;
    const fallback = { left, top, bottom: top + 24 };
    if (!node) return;
    let frame = 0;
    const position = (): void => {
      frame = 0;
      const rect = target?.getBoundingClientRect() ?? fallback;
      let visible = !target || target.isConnected;
      let clipTop = 0,
        clipLeft = 0,
        clipBottom = window.innerHeight,
        clipRight = window.innerWidth;
      for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clipTop = Math.max(clipTop, bounds.top);
          clipBottom = Math.min(clipBottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clipLeft = Math.max(clipLeft, bounds.left);
          clipRight = Math.min(clipRight, bounds.right);
        }
      }
      if (target)
        visible &&=
          rect.bottom > clipTop &&
          rect.top < clipBottom &&
          rect.left < clipRight &&
          target.getBoundingClientRect().right > clipLeft;
      node.style.visibility = visible ? 'visible' : 'hidden';
      const size = node.getBoundingClientRect();
      const placed = previewPosition(rect, size, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      node.style.left = `${placed.left}px`;
      node.style.top = `${placed.top}px`;
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(position);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    if (target) observer.observe(target);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    position();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  });
</script>

<div
  bind:this={element}
  use:portal
  data-attachment-preview
  role="tooltip"
  aria-label={label}
  {onmouseenter}
  {onmouseleave}
  class="bg-popover text-popover-foreground fixed z-[100] overflow-auto rounded-md border p-2 text-xs shadow-lg"
  style="width: min(20rem, calc(100vw - 1rem)); max-height: min(20rem, calc(100dvh - 1rem));"
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
      class="overflow-auto font-mono whitespace-pre-wrap"
      style="max-height: min(18rem, calc(100dvh - 3rem));">{text}</pre>
  {/if}
</div>

<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import { onDestroy } from 'svelte';
  let {
    label,
    image,
    text,
    missing = false,
  }: {
    label: string;
    image?: ImageRef;
    text?: string;
    missing?: boolean;
  } = $props();
  let anchor = $state<{ left: number; top: number } | null>(null);
  let pinned = $state(false);
  let scrollElement = $state<HTMLPreElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let previewElement = $state<HTMLDivElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = (): void => clearTimeout(timer);
  const hide = (): void => {
    keep();
    if (!pinned)
      timer = setTimeout(() => {
        if (!pinned) anchor = null;
      }, 180);
  };
  onDestroy(keep);
  const show = (event: Event): void => {
    if (pinned) return;
    keep();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    anchor = { left: rect.left, top: rect.top - 6 };
  };
  $effect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        (button?.contains(event.target) || previewElement?.contains(event.target))
      )
        return;
      pinned = false;
      anchor = null;
    };
    document.addEventListener('pointerdown', outside, true);
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        pinned = false;
        anchor = null;
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  });
</script>

<button
  bind:this={button}
  type="button"
  data-attachment-badge
  class="rounded bg-sky-500/15 px-0.5 text-sky-900 dark:text-sky-200"
  aria-label={label}
  onmouseenter={show}
  onmouseleave={hide}
  onfocus={show}
  onblur={() => {
    if (!pinned) anchor = null;
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      pinned = false;
      anchor = null;
    }
  }}
  onclick={(e) => {
    show(e);
    keep();
    pinned = true;
  }}
  onwheel={(e) => {
    if (text === undefined) return;
    show(e);
    if (scrollElement) {
      e.preventDefault();
      scrollElement.scrollTop += e.deltaY;
    }
  }}>{label}</button
>
{#if anchor}
  <AttachmentPreview
    {label}
    {image}
    {text}
    {missing}
    {...anchor}
    anchor={button ?? undefined}
    onmouseenter={keep}
    onmouseleave={hide}
    bind:scrollElement
    bind:element={previewElement}
  />
{/if}

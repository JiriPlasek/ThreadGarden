<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import { onDestroy } from 'svelte';
  let {
    label,
    image,
    text,
    missing = false,
    onclick,
  }: {
    label: string;
    image?: ImageRef;
    text?: string;
    missing?: boolean;
    onclick?: () => void;
  } = $props();
  let anchor = $state<{ left: number; top: number } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = (): void => clearTimeout(timer);
  const hide = (): void => {
    timer = setTimeout(() => (anchor = null), 180);
  };
  onDestroy(keep);
  const show = (event: Event): void => {
    keep();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    anchor = { left: rect.left, top: rect.top - 6 };
  };
</script>

<button
  type="button"
  class="rounded bg-sky-500/15 px-0.5 text-sky-900 dark:text-sky-200"
  aria-label={label}
  onmouseenter={show}
  onmouseleave={hide}
  onfocus={show}
  onblur={() => (anchor = null)}
  onkeydown={(e) => {
    if (e.key === 'Escape') anchor = null;
  }}
  {onclick}>{label}</button
>
{#if anchor}
  <AttachmentPreview
    {label}
    {image}
    {text}
    {missing}
    {...anchor}
    onmouseenter={keep}
    onmouseleave={hide}
  />
{/if}

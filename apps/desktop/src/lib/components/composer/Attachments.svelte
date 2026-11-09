<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import XIcon from '@lucide/svelte/icons/x';

  /** Thumbnails of the images about to be sent, each with a remove button. */
  let {
    images,
    numbers = [],
    onRemove,
  }: { images: readonly ImageRef[]; numbers?: number[]; onRemove: (i: number) => void } = $props();
  let preview = $state<{ image: ImageRef; number: number; left: number; top: number } | null>(null);
</script>

{#if images.length > 0}
  <ul class="flex flex-wrap gap-1.5 px-2 pt-2" aria-label="Attached images">
    {#each images as img, i (i)}
      <li class="group relative">
        <button
          type="button"
          aria-label="Preview image {numbers[i] ?? i + 1}"
          onmouseenter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            preview = { image: img, number: numbers[i] ?? i + 1, left: r.left, top: r.top - 6 };
          }}
          onfocus={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            preview = { image: img, number: numbers[i] ?? i + 1, left: r.left, top: r.top - 6 };
          }}
          onmouseleave={() => (preview = null)}
          onblur={() => (preview = null)}
        >
          <img
            src="data:{img.mediaType};base64,{img.data}"
            alt="Attached image {numbers[i] ?? i + 1}"
            class="size-14 rounded border object-cover"
          />
          <span class="bg-background absolute bottom-0 left-0 rounded px-1 text-xs"
            >#{numbers[i] ?? i + 1}</span
          ></button
        >
        <button
          type="button"
          class="bg-background absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-xs"
          aria-label="Remove image {numbers[i] ?? i + 1}"
          onclick={() => onRemove(i)}
        >
          <XIcon class="size-3.5" aria-hidden="true" />
        </button>
      </li>
    {/each}
  </ul>
{/if}

{#if preview}<AttachmentPreview
    image={preview.image}
    label="Image #{preview.number}"
    left={preview.left}
    top={preview.top}
  />{/if}

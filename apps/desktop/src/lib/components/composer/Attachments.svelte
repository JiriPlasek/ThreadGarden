<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import AttachmentBadge from './AttachmentBadge.svelte';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import XIcon from '@lucide/svelte/icons/x';

  /** Attachment tiles beside positional badges; only drafts offer removal. */
  let {
    images,
    numbers = [],
    onRemove,
    pastes = [],
    onRemovePaste,
  }: {
    images: readonly ImageRef[];
    numbers?: number[];
    onRemove?: (i: number) => void;
    pastes?: { number: number; text: string }[];
    onRemovePaste?: (number: number) => void;
  } = $props();
  let preview = $state<{
    image: ImageRef;
    number: number;
    left: number;
    top: number;
    anchor: HTMLElement;
  } | null>(null);
</script>

<div class="flex flex-wrap gap-1.5">
  {#if images.length > 0}
    <ul class="flex flex-wrap gap-1.5" aria-label="Attached images">
      {#each images as img, i (i)}
        <li class="group relative">
          <button
            type="button"
            aria-label="Preview image {numbers[i] ?? i + 1}"
            onmouseenter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              preview = {
                image: img,
                number: numbers[i] ?? i + 1,
                left: r.left,
                top: r.top - 6,
                anchor: e.currentTarget,
              };
            }}
            onfocus={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              preview = {
                image: img,
                number: numbers[i] ?? i + 1,
                left: r.left,
                top: r.top - 6,
                anchor: e.currentTarget,
              };
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
          {#if onRemove}<button
              type="button"
              class="bg-background absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-xs"
              aria-label="Remove image {numbers[i] ?? i + 1}"
              onclick={() => onRemove(i)}
            >
              <XIcon class="size-3.5" aria-hidden="true" />
            </button>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if pastes.length > 0}
    <ul class="flex flex-wrap gap-1.5" aria-label="Attached pasted text">
      {#each pastes as paste (paste.number)}
        <li class="relative">
          <AttachmentBadge
            label="Paste #{paste.number}"
            ariaLabel="Preview pasted text {paste.number}"
            text={paste.text}
            tile
          />
          {#if onRemovePaste}<button
              type="button"
              class="bg-background absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-xs"
              aria-label="Remove pasted text {paste.number}"
              onclick={() => onRemovePaste?.(paste.number)}
            >
              <XIcon class="size-3.5" aria-hidden="true" />
            </button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if preview}<AttachmentPreview
    image={preview.image}
    label="Image #{preview.number}"
    left={preview.left}
    top={preview.top}
    anchor={preview.anchor}
  />{/if}

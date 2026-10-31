<script lang="ts">
  import type { ImageRef } from '@threadgarden/protocol';
  import XIcon from '@lucide/svelte/icons/x';

  /** Thumbnails of the images about to be sent, each with a remove button. */
  let { images, onRemove }: { images: readonly ImageRef[]; onRemove: (i: number) => void } =
    $props();
</script>

{#if images.length > 0}
  <ul class="flex flex-wrap gap-1.5 px-2 pt-2" aria-label="Attached images">
    {#each images as img, i (i)}
      <li class="group relative">
        <img
          src="data:{img.mediaType};base64,{img.data}"
          alt="Attached image {i + 1}"
          class="size-14 rounded border object-cover"
        />
        <button
          type="button"
          class="bg-background absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-xs"
          aria-label="Remove image {i + 1}"
          onclick={() => onRemove(i)}
        >
          <XIcon class="size-3.5" aria-hidden="true" />
        </button>
      </li>
    {/each}
  </ul>
{/if}

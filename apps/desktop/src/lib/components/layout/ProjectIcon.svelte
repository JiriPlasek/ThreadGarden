<script lang="ts">
  import { useApp } from '#lib/state/context.js';
  import type { ProjectIconsState } from '#lib/state/project-icons.svelte.js';
  import { cn } from '#lib/utils.js';
  import { tileColor, tileLetter, whenVisible } from './project-icon';

  /**
   * A project's icon (v1.3 §5): its favicon as a rounded image at the row-icon
   * size (1rem, scaling with the interface size), or a
   * letter tile while unknown and for projects without one. Decorative: the
   * project's name is always shown next to it. The icon is asked for once the
   * element scrolls into view. `icons`: the project's machine's (This PC's by default).
   */
  let {
    projectId,
    name,
    icons: given,
    class: className = '',
  }: { projectId: string; name: string; icons?: ProjectIconsState; class?: string } = $props();

  const { places } = useApp();
  const icons = $derived(given ?? places.icons);

  let el = $state<HTMLSpanElement | null>(null);
  /** An image that failed to decode falls back to the tile. */
  let broken = $state<string | null>(null);
  const url = $derived(icons.url(projectId));

  $effect(() => {
    const node = el;
    const id = projectId;
    // Asked for (or answered) already: nothing to watch.
    if (!node || icons.asked(id)) return;
    return whenVisible(node, () => icons.want(id));
  });
</script>

<span
  bind:this={el}
  class={cn('inline-flex size-4 shrink-0 items-center justify-center', className)}
  data-project-icon={projectId}
>
  {#if url && url !== broken}
    <img
      src={url}
      alt=""
      width="16"
      height="16"
      draggable="false"
      class="size-4 rounded-[3px] object-contain"
      onerror={() => (broken = url)}
    />
  {:else}
    <!-- The letter is CSS content, so the row's text stays just the project's name. -->
    <span
      aria-hidden="true"
      data-letter={tileLetter(name)}
      class="flex size-4 items-center justify-center rounded-[3px] text-[0.625rem] leading-none font-semibold text-white select-none before:content-[attr(data-letter)]"
      style:background-color={tileColor(projectId)}
    ></span>
  {/if}
</span>

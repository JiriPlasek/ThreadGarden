<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * Fixed-row-height virtual list: only the rows in view (plus `overscan` above and
   * below) are in the DOM. `onEndReached` fires when the window gets within
   * `endThreshold` rows of the end (guarding against duplicate loads is the caller's job).
   */
  let {
    items,
    rowHeight,
    key,
    row,
    overscan = 8,
    endThreshold = 10,
    onEndReached,
    fallbackHeight = 600,
    viewport = $bindable(null),
    ...rest
  }: {
    items: readonly T[];
    rowHeight: number;
    key: (item: T) => string;
    row: Snippet<[T, number]>;
    overscan?: number;
    endThreshold?: number;
    onEndReached?: () => void;
    /** Viewport height used until the real one is measured (and in tests). */
    fallbackHeight?: number;
    viewport?: HTMLDivElement | null;
  } & Omit<HTMLAttributes<HTMLDivElement>, 'children'> = $props();

  let scrollTop = $state(0);
  let measured = $state(0);
  const height = $derived(measured || fallbackHeight);
  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = $derived(
    Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan),
  );
  const windowed = $derived(items.slice(start, end));

  $effect(() => {
    if (items.length > 0 && end >= items.length - endThreshold) {
      untrack(() => onEndReached?.());
    }
  });

  /** Jumps to the top (e.g. when the list's contents are replaced). */
  export const scrollToTop = (): void => {
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
  };

  /** Scrolls the least distance that brings row `index` fully into view. */
  export const scrollToIndex = (index: number): void => {
    if (!viewport) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + height) viewport.scrollTop = bottom - height;
    scrollTop = viewport.scrollTop;
  };
</script>

<div
  {...rest}
  bind:this={viewport}
  bind:clientHeight={measured}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
  <div style:height="{items.length * rowHeight}px" style:position="relative">
    <div style:transform="translateY({start * rowHeight}px)">
      {#each windowed as item, i (key(item))}
        <div style:height="{rowHeight}px">
          {@render row(item, start + i)}
        </div>
      {/each}
    </div>
  </div>
</div>

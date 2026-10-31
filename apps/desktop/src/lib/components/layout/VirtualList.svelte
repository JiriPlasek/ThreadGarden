<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * Virtual list: only the rows in view (plus `overscan` above and below) are in
   * the DOM. Every row has a fixed height, either one for all (`rowHeight` a
   * number) or one per kind of row (a function, e.g. shorter section headers).
   * `onEndReached` fires when the window gets within `endThreshold` rows of the
   * end (guarding against duplicate loads is the caller's job).
   *
   * Sticky headers: rows for which `isSticky` holds are section headers. Once
   * the current section's header scrolls out of view, `sticky` renders a copy
   * pinned to the top, which the next header pushes up as it arrives.
   */
  let {
    items,
    rowHeight,
    key,
    row,
    isSticky,
    sticky,
    overscan = 8,
    endThreshold = 10,
    onEndReached,
    fallbackHeight = 600,
    viewport = $bindable(null),
    ...rest
  }: {
    items: readonly T[];
    rowHeight: number | ((item: T) => number);
    key: (item: T) => string;
    row: Snippet<[T, number]>;
    isSticky?: (item: T) => boolean;
    sticky?: Snippet<[T]>;
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

  const heightOf = (item: T): number =>
    typeof rowHeight === 'number' ? rowHeight : rowHeight(item);

  /** `offsets[i]`: the top of row `i`; `offsets[items.length]`: the total height. */
  const offsets = $derived.by(() => {
    const o = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i]! + heightOf(items[i]!);
    return o;
  });

  /** Indices of the sticky rows, ascending. */
  const stickies = $derived.by(() => {
    if (!isSticky) return [];
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) if (isSticky(items[i]!)) out.push(i);
    return out;
  });

  /** The row at `y` px from the top (clamped to the rows). */
  const rowAt = (y: number): number => {
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /** Position in `stickies` of the last sticky row at or above row `index` (-1 if none). */
  const stickyAt = (index: number): number => {
    let lo = 0;
    let hi = stickies.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (stickies[mid]! <= index) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };

  const start = $derived(items.length === 0 ? 0 : Math.max(0, rowAt(scrollTop) - overscan));
  const end = $derived(
    items.length === 0 ? 0 : Math.min(items.length, rowAt(scrollTop + height) + 1 + overscan),
  );
  const windowed = $derived(items.slice(start, end));

  /** The pinned header: once its own row has (partly) scrolled out of view. */
  const pinned = $derived.by(() => {
    if (!sticky || stickies.length === 0 || items.length === 0) return null;
    const s = stickyAt(rowAt(scrollTop));
    if (s < 0) return null;
    const index = stickies[s]!;
    if (offsets[index]! >= scrollTop) return null;
    const h = heightOf(items[index]!);
    const next = stickies[s + 1];
    // The next header pushes this one up as it reaches the top.
    const push = next === undefined ? 0 : Math.min(0, offsets[next]! - scrollTop - h);
    return { item: items[index]!, h, push };
  });

  $effect(() => {
    if (items.length > 0 && end >= items.length - endThreshold) {
      untrack(() => onEndReached?.());
    }
  });

  /** The first and last row (partly) in view. */
  export const visibleRows = (): [number, number] =>
    items.length === 0 ? [0, -1] : [rowAt(scrollTop), rowAt(scrollTop + height - 1)];

  /** Jumps to the top (e.g. when the list's contents are replaced). */
  export const scrollToTop = (): void => {
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
  };

  /**
   * Scrolls the least distance that brings row `index` fully into view, below
   * the pinned header of its section (the first row of a section brings its
   * header along).
   */
  export const scrollToIndex = (index: number): void => {
    if (!viewport || index < 0 || index >= items.length) return;
    const top = offsets[index]!;
    const bottom = offsets[index + 1]!;
    const s = stickyAt(index);
    const header = s < 0 ? -1 : stickies[s]!;
    const cover = header < 0 || header === index ? 0 : heightOf(items[header]!);
    if (top - cover < viewport.scrollTop) viewport.scrollTop = top - cover;
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
  {#if pinned && sticky}
    <!-- Takes no room (negative margin): it overlays the rows below it. -->
    <div
      style:position="sticky"
      style:top="0"
      style:z-index="1"
      style:height="{pinned.h}px"
      style:margin-bottom="-{pinned.h}px"
      style:transform={pinned.push ? `translateY(${pinned.push}px)` : undefined}
    >
      {@render sticky(pinned.item)}
    </div>
  {/if}
  <div style:height="{offsets[items.length]}px" style:position="relative">
    <div style:transform="translateY({offsets[start]}px)">
      {#each windowed as item, i (key(item))}
        <div style:height="{heightOf(item)}px">
          {@render row(item, start + i)}
        </div>
      {/each}
    </div>
  </div>
</div>

<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import { onDestroy, untrack } from 'svelte';
  import type { ListMemory } from '#lib/state/chats.svelte.js';
  import { setChatActions } from './context';
  import ItemBoundary from './items/ItemBoundary.svelte';
  import ItemView from './items/ItemView.svelte';
  import ToolGroup from './items/ToolGroup.svelte';
  import UnknownItem from './items/UnknownItem.svelte';
  import { buildRows, type Row } from './rows';
  import { captureAnchor, computeOffsets, restoreAnchor, visibleRange } from './virtual';

  /**
   * The chat's messages as a variable-height virtual list. Rows are measured
   * (synchronously after each render, and by a ResizeObserver for later growth);
   * unmeasured rows use an estimate. While the user is at the bottom the list
   * sticks there (streaming); otherwise the row at the top of the viewport stays
   * put when rows above it are measured or older items are prepended. Near the
   * top it asks for older items.
   */
  let {
    items,
    hasMore = false,
    loadingOlder = false,
    onLoadOlder,
    onFork,
    memory,
    fallbackHeight = 600,
    overscan = 6,
  }: {
    items: readonly ChatItem[];
    hasMore?: boolean;
    loadingOlder?: boolean;
    onLoadOlder?: () => void;
    onFork?: (itemId: string) => void;
    /** Heights and scroll position to resume from (kept per chat across tab switches). */
    memory?: ListMemory;
    /** Viewport height used until the real one is measured (and in tests). */
    fallbackHeight?: number;
    overscan?: number;
  } = $props();

  /** Within this distance of the bottom the list sticks to new output. */
  const STICK_PX = 8;
  /** Within this distance of the top older items are requested. */
  const LOAD_OLDER_PX = 800;

  setChatActions({
    get fork() {
      return onFork;
    },
  });

  const mem: ListMemory = untrack(() => memory) ?? {
    heights: new Map(),
    stick: true,
    anchor: null,
  };

  let viewport = $state<HTMLDivElement | null>(null);
  let content = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let measuredHeight = $state(0);
  /** Bumped whenever `mem.heights` changes (the map itself is not reactive). */
  let version = $state(0);
  /** Mirrors `mem.stick` for the "jump to latest" button. */
  let stuck = $state(mem.stick);

  const rows = $derived(buildRows(items));
  /** Anchors name a row by its first item id: stable when runs grow or regroup. */
  const anchorKeys = $derived(rows.map((r) => r.itemIds[0] ?? r.key));
  const rowOfItem = $derived.by(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => r.itemIds.forEach((id) => m.set(id, i)));
    return m;
  });

  const estimate = (row: Row): number => {
    if (row.kind !== 'item') return 28;
    const it = row.item;
    switch (it.kind) {
      case 'user':
        return 44 + 20 * Math.min(20, Math.floor(it.text.length / 110));
      case 'assistantText':
        return 32 + 21 * Math.min(120, Math.ceil(it.markdown.length / 110));
      case 'todo':
        return 52 + 22 * it.todos.length;
      case 'toolCall':
        return row.children ? 40 : 28;
      case 'system':
        return 40;
      default:
        return 30;
    }
  };

  const offsets = $derived.by(() => {
    void version;
    return computeOffsets(rows.length, (i) => {
      const row = rows[i]!;
      return mem.heights.get(row.key) ?? estimate(row);
    });
  });
  const total = $derived(offsets[rows.length] ?? 0);
  const height = $derived(measuredHeight || fallbackHeight);
  const range = $derived(visibleRange(offsets, scrollTop, height, overscan));
  const windowed = $derived(rows.slice(range[0], range[1]));

  // ---- scrolling ----

  /** The scrollTop we set last: its scroll event is ours, not the user's. */
  let expected = -1;

  const maxScroll = (): number => Math.max(0, total - height);

  const setScroll = (y: number): void => {
    const top = Math.round(Math.min(maxScroll(), Math.max(0, y)));
    if (viewport && Math.abs(viewport.scrollTop - top) >= 1) viewport.scrollTop = top;
    expected = viewport ? viewport.scrollTop : top;
    scrollTop = expected;
  };

  const remember = (): void => {
    mem.anchor = captureAnchor(anchorKeys, offsets, scrollTop);
  };

  const maybeLoadOlder = (): void => {
    if (hasMore && !loadingOlder && scrollTop < LOAD_OLDER_PX) onLoadOlder?.();
  };

  /** Puts the view back where it belongs after rows or heights changed. */
  const reposition = (): void => {
    if (mem.stick) {
      setScroll(maxScroll());
      remember();
    } else if (mem.anchor) {
      const y = restoreAnchor(mem.anchor, (id) => rowOfItem.get(id) ?? -1, offsets);
      if (y === null) remember();
      else setScroll(y);
    }
    maybeLoadOlder();
  };

  const onscroll = (): void => {
    if (!viewport) return;
    const top = viewport.scrollTop;
    if (Math.abs(top - expected) < 1) return;
    expected = -1;
    scrollTop = top;
    mem.stick = total - (top + height) <= STICK_PX;
    stuck = mem.stick;
    remember();
    maybeLoadOlder();
  };

  const onwheel = (e: WheelEvent): void => {
    // Scrolling up while output streams in must win over sticking to the bottom.
    if (e.deltaY < 0 && mem.stick && maxScroll() > 0) {
      mem.stick = false;
      stuck = false;
      remember();
    }
  };

  export const scrollToBottom = (): void => {
    mem.stick = true;
    stuck = true;
    setScroll(maxScroll());
    remember();
  };

  // ---- measuring ----

  const setHeight = (key: string, h: number): boolean => {
    if (!(h > 0) || Math.abs((mem.heights.get(key) ?? -1) - h) < 0.5) return false;
    mem.heights.set(key, h);
    return true;
  };

  /** Measures the rendered rows now (before paint); true if any height changed. */
  const measureWindow = (): boolean => {
    if (!content) return false;
    let changed = false;
    for (const el of content.children) {
      const key = (el as HTMLElement).dataset.row;
      if (key !== undefined) changed = setHeight(key, el.getBoundingClientRect().height) || changed;
    }
    return changed;
  };

  // Later size changes (expanding a row, streamed text, images) arrive from a
  // ResizeObserver and are applied on the next frame: changing layout inside its
  // callback would trigger "loop completed with undelivered notifications".
  const pending = new Map<string, number>();
  let frame = 0;
  const nextFrame = (cb: () => void): number =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, 16) as unknown as number);

  const applyPending = (): void => {
    frame = 0;
    let changed = false;
    for (const [key, h] of pending) changed = setHeight(key, h) || changed;
    pending.clear();
    if (changed) version++;
  };

  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const key = el.dataset.row;
            if (key === undefined) continue;
            const h = e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
            pending.set(key, h);
          }
          if (pending.size > 0 && !frame) frame = nextFrame(applyPending);
        })
      : null;

  const observe = (el: HTMLElement) => {
    observer?.observe(el);
    return () => observer?.unobserve(el);
  };

  onDestroy(() => {
    observer?.disconnect();
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  });

  // After every render of a new window, row set or height: measure what is on
  // screen, then restore the scroll position. Runs before the browser paints.
  $effect(() => {
    void offsets;
    void height;
    void range;
    void viewport;
    untrack(() => {
      if (measureWindow()) {
        version++;
        return;
      }
      reposition();
    });
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <div
    bind:this={viewport}
    bind:clientHeight={measuredHeight}
    {onscroll}
    {onwheel}
    data-viewport
    role="region"
    aria-label="Messages"
    tabindex="-1"
    class="min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none]"
  >
    <div class="relative" style:height="{total}px">
      <div
        bind:this={content}
        class="absolute inset-x-0 top-0"
        style:transform="translateY({offsets[range[0]] ?? 0}px)"
      >
        {#each windowed as row, i (row.key)}
          <div
            data-row={row.key}
            data-top={offsets[range[0] + i]}
            class="mx-auto max-w-4xl px-4 py-1"
            {@attach observe}
          >
            {#if row.kind === 'item'}
              <ItemView item={row.item} children={row.children} />
            {:else if row.kind === 'unknownGroup'}
              <ItemBoundary item={row.items}><UnknownItem items={row.items} /></ItemBoundary>
            {:else}
              <ItemBoundary item={row.items}
                ><ToolGroup name={row.name} items={row.items} /></ItemBoundary
              >
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
  {#if loadingOlder}
    <div
      class="bg-background/90 text-muted-foreground absolute top-2 left-1/2 -translate-x-1/2 rounded-full border px-2.5 py-0.5 text-xs"
      role="status"
    >
      Loading earlier messages…
    </div>
  {/if}
  {#if !stuck && total > height}
    <button
      type="button"
      class="bg-background text-muted-foreground hover:text-foreground absolute right-4 bottom-3 flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs shadow-sm"
      onclick={scrollToBottom}
    >
      <ArrowDownIcon class="size-3.5" aria-hidden="true" /> Jump to latest
    </button>
  {/if}
</div>

<script lang="ts">
  import type { ChatItem, TimelineBlock } from '@threadgarden/protocol';
  import { tick, untrack } from 'svelte';
  import { RequestError } from '#lib/service/client.js';
  import { fullTime } from '#lib/format/time.js';
  import { elapsed, tokens } from './format';
  import { layoutTimeline } from './timeline-layout';
  import ItemView from './items/ItemView.svelte';
  import ActivityStrip from './ActivityStrip.svelte';
  import { ACTIVITY_COLORS, activitySummary } from './timeline-activity';
  import { setChatActions } from './context';

  // Historical inspection must not offer live permission decisions or fork actions.
  setChatActions({});
  const activityDescriptionId = $props.id();

  let {
    sessionId,
    revision = 0,
    load,
    detail,
  }: {
    sessionId: string;
    revision?: number;
    load: () => Promise<{ blocks: TimelineBlock[] }>;
    detail: (blockId: string, offset: number) => Promise<{ items: ChatItem[]; hasMore: boolean }>;
  } = $props();
  let blocks = $state.raw<TimelineBlock[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let scale = $state(2);
  let scrollArea = $state<HTMLDivElement | null>(null);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let scrollOuterWidth = $state(0);
  let scrollOuterHeight = $state(0);
  const rightGutter = $derived(Math.max(0, scrollOuterWidth - viewportWidth));
  const bottomGutter = $derived(Math.max(0, scrollOuterHeight - viewportHeight));
  let selectedId = $state<string | null>(null);
  let details = $state.raw<ChatItem[]>([]);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  let trigger: HTMLButtonElement | null = null;
  let hasMore = $state(false);
  let generation = 0;
  let refreshGeneration = 0;
  let detailPages = 1;
  const selected = $derived(blocks.find((b) => b.id === selectedId));
  const layout = $derived(layoutTimeline(blocks, now, scale));
  const durationOf = (b: TimelineBlock): string =>
    b.startedAt === undefined
      ? 'Time unknown'
      : b.endedAt !== undefined
        ? elapsed(b.endedAt - b.startedAt)
        : b.status === 'running'
          ? elapsed(now - b.startedAt)
          : 'End time unknown';
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const gapDuration = (ms: number): string => {
    const days = Math.floor(ms / 86_400_000);
    return days >= 7 && days % 7 === 0
      ? `${days / 7} weeks`
      : days > 0
        ? `${days} days ${Math.floor(ms / 3_600_000) % 24}h`
        : elapsed(ms);
  };
  const label = (b: TimelineBlock): string =>
    `${b.kind === 'turn' ? 'Turn' : 'Agent'}: ${b.title} · ${b.status} · ${durationOf(b)}`;
  const description = (b: TimelineBlock): string =>
    [
      label(b),
      b.startedAt ? fullTime(b.startedAt) : '',
      b.activity ? activitySummary(b.activity) : '',
    ]
      .filter(Boolean)
      .join('\n');
  const tokenText = (b: TimelineBlock): string =>
    b.tokens === undefined ? '' : `${tokens(b.tokens)} tokens`;
  const tokenHint =
    'Reported input and output tokens processed, including cached input when available.';
  const tint = (b: TimelineBlock): string =>
    b.status === 'failed'
      ? 'border-red-500 bg-red-500/15'
      : b.status === 'running'
        ? 'border-blue-500 bg-blue-500/15'
        : b.status === 'completed'
          ? 'border-emerald-500 bg-emerald-500/15'
          : 'border-muted-foreground bg-muted';

  const refresh = async (id = sessionId): Promise<void> => {
    const token = ++refreshGeneration;
    try {
      const response = await load();
      if (id !== sessionId || token !== refreshGeneration) return;
      blocks = response.blocks.filter((b) => b.startedAt !== undefined || b.endedAt !== undefined);
      error = null;
      if (selectedId && blocks.some((b) => b.id === selectedId)) void readDetails(selectedId);
    } catch (err) {
      if (id === sessionId && token === refreshGeneration)
        error =
          err instanceof RequestError && err.code === 'METHOD_NOT_FOUND'
            ? 'Timeline needs a newer service on this machine. Update it or switch back to Conversation.'
            : err instanceof Error
              ? err.message
              : String(err);
    } finally {
      if (id === sessionId && token === refreshGeneration) loading = false;
    }
  };
  $effect(() => {
    const id = sessionId;
    blocks = [];
    selectedId = null;
    loading = true;
    untrack(() => void refresh(id));
    const timer = setInterval(() => {
      now = Date.now();
      if (blocks.some((b) => b.status === 'running')) void refresh(id);
    }, 5000);
    return () => {
      clearInterval(timer);
      generation++;
      refreshGeneration++;
    };
  });
  $effect(() => {
    void revision;
    const timer = setTimeout(() => void refresh(), 350);
    return () => clearTimeout(timer);
  });
  const readDetails = async (id: string, showLoading = false): Promise<void> => {
    const token = ++generation;
    if (showLoading) detailLoading = true;
    detailError = null;
    try {
      const items: ChatItem[] = [];
      let more = false;
      const pages = detailPages;
      for (let page = 0; page < pages; page++) {
        const r = await detail(id, items.length);
        if (token !== generation) return;
        items.push(...r.items);
        more = r.hasMore;
        if (!more || r.items.length === 0) break;
      }
      if (token !== generation) return;
      details = items;
      hasMore = more;
    } catch (err) {
      if (token === generation) detailError = err instanceof Error ? err.message : String(err);
    } finally {
      if (token === generation) detailLoading = false;
    }
  };
  const inspect = async (id: string, more = false): Promise<void> => {
    selectedId = id;
    if (more) detailPages++;
    else {
      detailPages = 1;
      details = [];
      hasMore = false;
    }
    detailLoading = true;
    if (!more) {
      await tick();
      closeButton?.focus();
    }
    await readDetails(id, true);
  };
  const openBlock = (id: string, button: HTMLButtonElement): void => {
    trigger = button;
    void inspect(id);
  };
  const close = (): void => {
    selectedId = null;
    generation++;
    trigger?.focus();
  };
  const zoom = (factor: number): void => {
    scale = Math.max(0.25, Math.min(256, scale * factor));
  };
</script>

{#snippet gridLines()}
  {#each layout.ticks as t}
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 border-t border-border/60"
      style:top="{t.y}px"
    ></div>
  {/each}
{/snippet}

{#snippet colorKey()}
  <div class="flex flex-wrap gap-x-3 gap-y-1">
    {#each ['Tool pending', 'Reasoning observed', 'User message', 'Assistant response'] as name, channel}
      <span class="inline-flex items-center gap-1"
        ><span
          class="inline-block size-2 shrink-0 rounded-sm"
          style:background={ACTIVITY_COLORS[channel]}
        ></span>{name}</span
      >
    {/each}
    <span class="inline-flex items-center gap-1"
      ><span class="inline-block size-2 shrink-0 rounded-sm bg-slate-400/50"
      ></span>Unclassified</span
    >
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="relative flex min-h-0 flex-1 flex-col"
  aria-label="Chat timeline"
  onkeydowncapture={(e) => {
    if (selectedId && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }}
>
  <div
    class="pointer-events-none absolute left-3 z-30 flex flex-wrap items-end justify-between gap-2"
    style:right="{12 + rightGutter}px"
    style:bottom="{12 + bottomGutter}px"
  >
    <details
      open
      class="pointer-events-auto relative rounded-md border bg-background/95 text-xs shadow-sm"
    >
      <summary class="cursor-pointer px-3 py-1.5 font-medium">Color meanings</summary>
      <div
        role="group"
        aria-label="Color meanings"
        class="absolute bottom-full left-0 mb-2 rounded-md border bg-background/95 p-3 shadow-sm"
        style:width="{Math.min(288, Math.max(180, viewportWidth - 24))}px"
      >
        <p class="mb-2 font-medium">Activity strip</p>
        {@render colorKey()}
        <p class="mt-2 text-muted-foreground">Gray means unclassified, not necessarily idle.</p>
        <div class="mt-2 border-t pt-2 text-muted-foreground">
          Block tint: blue = running, green = completed, red = failed; gray = other/unknown.
        </div>
      </div>
    </details>
    <div
      role="group"
      aria-label="Timeline navigation"
      title="Zoom: {scale} px/min. Short entries are expanded to keep their titles readable."
      class="pointer-events-auto inline-flex overflow-hidden rounded-md border bg-background/95 text-xs shadow-sm"
    >
      <button
        class="px-2.5 py-1.5 hover:bg-muted disabled:opacity-40"
        aria-label="Zoom out timeline"
        disabled={scale <= 0.25}
        onclick={() => zoom(0.5)}>−</button
      >
      <button
        class="border-l px-2.5 py-1.5 hover:bg-muted disabled:opacity-40"
        aria-label="Zoom in timeline"
        disabled={scale >= 256}
        onclick={() => zoom(2)}>+</button
      >
      <button
        class="border-l px-2.5 py-1.5 hover:bg-muted"
        aria-label="Refresh"
        title="Refresh timeline"
        onclick={() => void refresh()}>↻</button
      >
      <button
        class="border-l px-2.5 py-1.5 hover:bg-muted"
        aria-label="Latest"
        title="Scroll to latest activity"
        onclick={() => scrollArea?.scrollTo({ top: scrollArea.scrollHeight, behavior: 'smooth' })}
        >↓</button
      >
    </div>
  </div>
  {#if error}<p role="alert" class="px-4 py-2 text-sm text-destructive">
      {error} <button class="underline" onclick={() => void refresh()}>Retry</button>
    </p>{/if}
  {#if loading}<p role="status" class="p-6 text-sm text-muted-foreground">Loading timeline…</p>
  {:else if blocks.length === 0 && !error}<p class="p-6 text-sm text-muted-foreground">
      No timeline entries to show.
    </p>
  {:else}
    <div
      bind:this={scrollArea}
      bind:clientWidth={viewportWidth}
      bind:clientHeight={viewportHeight}
      bind:offsetWidth={scrollOuterWidth}
      bind:offsetHeight={scrollOuterHeight}
      data-timeline-scroll
      class="min-h-0 flex-1 overflow-auto"
      onwheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          zoom(e.deltaY < 0 ? 2 : 0.5);
        }
      }}
    >
      <div
        class="sticky top-0 z-30 flex border-b bg-background text-xs font-medium"
        style:min-width="{320 + layout.lanes * 180}px"
      >
        <div class="sticky left-0 w-20 shrink-0 bg-background p-2">Time</div>
        <div class="sticky left-20 w-60 shrink-0 border-x bg-background p-2">Main chat</div>
        {#each Array(layout.lanes) as _, lane}<div class="w-45 shrink-0 p-2">
            Agent lane {lane + 1}
          </div>{/each}
      </div>
      <div
        class="relative flex"
        style:height="{layout.height}px"
        style:min-width="{320 + layout.lanes * 180}px"
      >
        <div
          class="sticky left-0 z-20 w-20 shrink-0 bg-background/95 text-[0.625rem] text-muted-foreground"
        >
          {#each layout.ticks as t}<time
              data-timeline-tick
              class="absolute right-0 left-2 -translate-y-full border-b border-border/60 pb-0.5 leading-3"
              style:top="{t.y}px"
              title={fullTime(t.at)}
              datetime={new Date(t.at).toISOString()}
            >
              {new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<br
              />{new Date(t.at).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>{/each}
        </div>
        <div class="sticky left-20 z-10 w-60 shrink-0 border-x bg-background/95">
          {@render gridLines()}
          {#each layout.waits as wait}<div
              class="pointer-events-none absolute inset-x-2 overflow-hidden rounded border-l-2 border-dashed border-muted-foreground/40 px-2 text-[0.625rem] text-muted-foreground"
              style:top="{wait.y}px"
              style:height="{wait.height}px"
              style:background={'repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--muted-foreground) 10%, transparent) 5px 6px)'}
            >
              {#if wait.height >= 20}Waiting for next message · {elapsed(wait.duration)}{/if}
            </div>{/each}
          {#each layout.placed.filter((b) => b.lane === -1) as p (p.block.id)}
            <button
              class="absolute inset-x-2 grid content-start overflow-hidden rounded border-l-3 px-2 text-left text-xs hover:ring-2 focus-visible:ring-2 {tint(
                p.block,
              )}"
              style:top="{p.y}px"
              style:height="{p.height}px"
              aria-label={label(p.block)}
              aria-pressed={selectedId === p.block.id}
              title={description(p.block)}
              aria-describedby={p.block.activity
                ? `${activityDescriptionId}-${p.block.id}`
                : undefined}
              onclick={(e) => openBlock(p.block.id, e.currentTarget)}
            >
              {#if p.block.activity}<span class="sr-only" id="{activityDescriptionId}-{p.block.id}"
                  >{activitySummary(p.block.activity)}</span
                ><ActivityStrip
                  activity={p.block.activity}
                  top={p.y}
                  height={p.height}
                  yOf={layout.yOf}
                />{/if}
              <time
                data-timeline-block-time
                class="text-[0.625rem] opacity-70"
                datetime={new Date(
                  p.block.promptAt ?? p.block.startedAt ?? p.block.endedAt!,
                ).toISOString()}
                title={fullTime(p.block.promptAt ?? p.block.startedAt ?? p.block.endedAt!)}
                >{clock(p.block.promptAt ?? p.block.startedAt ?? p.block.endedAt!)}</time
              >
              <div class="truncate font-medium">{p.block.title}</div>
              <div class="truncate opacity-70" title={tokenHint}>
                {durationOf(p.block)}{p.block.tokens !== undefined
                  ? ` · ${tokenText(p.block)}`
                  : ''}
              </div>
              {#if p.height >= 96}<div class="line-clamp-2 opacity-80">{p.block.outcome}</div>{/if}
            </button>
          {/each}
        </div>
        <div class="relative flex-1">
          {@render gridLines()}
          {#each layout.placed.filter((b) => b.lane >= 0) as p (p.block.id)}
            <button
              class="absolute grid w-41 content-start overflow-hidden rounded border-l-3 px-2 text-left text-xs hover:ring-2 focus-visible:ring-2 {tint(
                p.block,
              )}"
              style:left="{p.lane * 180 + 8}px"
              style:top="{p.y}px"
              style:height="{p.height}px"
              aria-label={label(p.block)}
              aria-pressed={selectedId === p.block.id}
              title={description(p.block)}
              aria-describedby={p.block.activity
                ? `${activityDescriptionId}-${p.block.id}`
                : undefined}
              onclick={(e) => openBlock(p.block.id, e.currentTarget)}
            >
              {#if p.block.activity}<span class="sr-only" id="{activityDescriptionId}-{p.block.id}"
                  >{activitySummary(p.block.activity)}</span
                ><ActivityStrip
                  activity={p.block.activity}
                  top={p.y}
                  height={p.height}
                  yOf={layout.yOf}
                />{/if}
              <div class="truncate font-medium">{p.block.title}</div>
              <div class="truncate opacity-70">
                <span title={tokenHint}>{tokenText(p.block)}</span>{p.block.tokens !== undefined
                  ? ' · '
                  : ''}{durationOf(p.block)}
              </div>
              {#if p.block.activity && p.block.activity.prompts > 1}<div
                  class="truncate text-[0.625rem] opacity-80"
                >
                  ↔ {p.block.activity.prompts} prompts
                </div>{/if}
              {#if p.height >= 66}<div class="truncate opacity-70">{p.block.model ?? ''}</div>{/if}
            </button>
          {/each}
        </div>
        {#each layout.gaps as gap}<div
            class="pointer-events-none absolute inset-x-20 z-20 border-y border-dashed bg-muted/95 px-3 py-1 text-[0.6875rem] text-muted-foreground"
            style:top="{gap.y}px"
          >
            ⋯ {gapDuration(gap.end - gap.start)} with no recorded activity ⋯
          </div>{/each}
        {#if layout.nowY !== undefined}<div
            class="pointer-events-none absolute inset-x-0 z-20 border-t border-blue-500"
            style:top="{layout.nowY}px"
          >
            <span class="bg-background px-2 text-[0.625rem] text-blue-500">Now</span>
          </div>{/if}
      </div>
    </div>
  {/if}
  {#if selected}
    <aside
      aria-label="Timeline details"
      class="absolute inset-y-0 right-0 z-40 flex w-full max-w-lg flex-col border-l bg-background shadow-xl"
    >
      <div class="flex items-start gap-3 border-b p-4">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-medium">{selected.title}</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            {durationOf(selected)}{selected.tokens !== undefined ? ` · ${tokenText(selected)}` : ''}
          </p>
          {#if selected.startedAt}<p class="mt-1 text-xs text-muted-foreground">
              {fullTime(selected.startedAt)}{selected.endedAt
                ? ` → ${fullTime(selected.endedAt)}`
                : ''}
            </p>{/if}
        </div>
        <button
          bind:this={closeButton}
          class="rounded border px-2 py-1 text-xs"
          aria-label="Close timeline details"
          onclick={close}>Close</button
        >
      </div>
      {#if selected.activity}
        <div class="border-b px-4 py-2 text-xs" aria-label="Recorded activity">
          <div class="mb-1">{@render colorKey()}</div>
          <p class="text-muted-foreground">{activitySummary(selected.activity)}</p>
        </div>
      {/if}
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        {#each details as item (item.id)}<div class="mb-4"><ItemView {item} /></div>{/each}
        {#if detailError}<p role="alert" class="text-sm text-destructive">{detailError}</p>
          <button class="text-xs underline" onclick={() => void inspect(selected!.id)}>Retry</button
          >{/if}
        {#if detailLoading}<p role="status" class="text-xs text-muted-foreground">
            Loading messages…
          </p>
        {:else if !details.length && !detailError}<p class="text-sm text-muted-foreground">
            No saved messages are available for this agent yet.
          </p>{/if}
        {#if hasMore && !detailLoading}<button
            class="rounded border px-3 py-2 text-xs"
            onclick={() => void inspect(selected!.id, true)}>Load more messages</button
          >{/if}
      </div>
    </aside>
  {/if}
</section>

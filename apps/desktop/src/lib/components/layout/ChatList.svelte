<script lang="ts">
  import type { ChatSummary } from '@pahub/protocol';
  import { untrack } from 'svelte';
  import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { rowPx } from '#lib/interface-scale.js';
  import { useApp } from '#lib/state/context.js';
  import { baseName } from './chat-info';
  import ChatListRow from './ChatListRow.svelte';
  import IconButton from './IconButton.svelte';
  import RenameDialog from './RenameDialog.svelte';
  import { groupChats, SECTION_LABELS, type HeaderRow, type ListRow } from './sections';
  import VirtualList from './VirtualList.svelte';

  /**
   * Middle column (spec §6.1): searchable chats of the selected place, in
   * recency sections with sticky headers (v1.2 §2): "Now" (needs you, your
   * turn, running) in the service's order, then Last 24 hours, Last 7 days,
   * Last 30 days and Older.
   *
   * Accessibility: the listbox holds the chats only. Section headers are
   * visual rows (`role="presentation"`, hidden from assistive technology);
   * each option names its section through `aria-describedby`, pointing at
   * per-section labels that are always in the DOM (a header row may be
   * virtualized away, a listbox group cannot span virtual rows).
   */
  let { onCollapse }: { onCollapse?: () => void } = $props();

  const { sessions, places, tabs, agents, settings, chats } = useApp();

  /**
   * Fixed row heights of the virtual list, in rem so they follow the interface
   * size: 3.25rem = 55 px at the 17 px base (a row's two lines take 2.375rem);
   * section headers 1.75rem = 30 px.
   */
  const ROW_REM = 3.25;
  const HEADER_REM = 1.75;
  const rowHeight = $derived(rowPx(ROW_REM, settings.scale));
  const headerHeight = $derived(rowPx(HEADER_REM, settings.scale));
  const heightOf = $derived((r: ListRow) => (r.kind === 'header' ? headerHeight : rowHeight));
  const PAGE_ROWS = 10;
  const SEARCH_DELAY_MS = 150;
  const CLOCK_MS = 30_000;
  const MINUTE_MS = 60_000;

  let list = $state<ReturnType<typeof VirtualList<ListRow>> | null>(null);
  let viewport = $state<HTMLDivElement | null>(null);
  let search = $state(sessions.query);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let renaming = $state<ChatSummary | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), CLOCK_MS);
    return () => {
      clearInterval(t);
      clearTimeout(searchTimer);
    };
  });

  // A different place or query is a different list: start at its top.
  $effect(() => {
    void places.selected;
    void sessions.query;
    untrack(() => list?.scrollToTop());
  });

  /** Sections move with the clock once a minute, not on every render or tick. */
  const minute = $derived(Math.floor(now / MINUTE_MS) * MINUTE_MS);
  const grouped = $derived(
    groupChats(sessions.items, minute, {
      // Every chat of these places is a "now" chat, whatever its status says by now.
      allNow: places.selected.kind === 'needsYou' || places.selected.kind === 'running',
      hasMore: sessions.nextCursor !== undefined,
    }),
  );

  /** The keyboard cursor follows the active tab until the user moves it. */
  let cursor = $derived<string | null>(tabs.active);
  const cursorIndex = $derived(cursor === null ? -1 : (grouped.indexOf.get(cursor) ?? -1));

  const names = $derived(new Map(places.projects.map((p) => [p.projectId, p.displayName])));
  const spansProjects = $derived(places.selected.kind !== 'project');
  const placeTitle = $derived.by(() => {
    const p = places.selected;
    if (p.kind === 'needsYou') return 'Needs you';
    if (p.kind === 'running') return 'Running';
    if (p.kind === 'all' || p.kind === 'active') return 'All chats';
    if (p.kind === 'onHold') return 'On hold';
    if (p.kind === 'archived') return 'Archived';
    return names.get(p.projectId) ?? 'Project';
  });
  const emptyText = $derived.by(() => {
    if (sessions.query) return `No chats match “${sessions.query}”`;
    const p = places.selected;
    if (p.kind === 'needsYou') return 'Nothing needs you right now.';
    if (p.kind === 'running') return 'No agents are working.';
    return 'No chats yet.';
  });

  const rowId = (sessionId: string): string => `chat-row-${sessionId}`;
  const sectionId = (section: string): string => `chat-section-${section}`;
  const headerSections = $derived(
    grouped.rows.filter((r): r is HeaderRow => r.kind === 'header').map((r) => r.section),
  );

  const onSearch = (value: string): void => {
    search = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void sessions.setQuery(value.trim()), SEARCH_DELAY_MS);
  };

  const open = (chat: ChatSummary): void => {
    cursor = chat.sessionId;
    tabs.openTab(chat.sessionId);
  };

  /** Moves the cursor to the `index`-th chat (headers are not stops). */
  const moveTo = (index: number): void => {
    const n = grouped.chats.length;
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, index));
    cursor = grouped.chats[i]!.sessionId;
    list?.scrollToIndex(grouped.rowOf[i]!);
  };

  const onListKey = (e: KeyboardEvent): void => {
    const i = cursorIndex;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(i + 1);
        break;
      case 'ArrowUp':
        moveTo(i < 0 ? 0 : i - 1);
        break;
      case 'PageDown':
        moveTo(i + PAGE_ROWS);
        break;
      case 'PageUp':
        moveTo(i - PAGE_ROWS);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(grouped.chats.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const chat = grouped.chats[i];
        if (chat) open(chat);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const onSearchKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      viewport?.focus();
      if (cursorIndex < 0) moveTo(0);
    } else if (e.key === 'Escape' && search) {
      e.preventDefault();
      onSearch('');
    }
  };

  const togglePin = (chat: ChatSummary): void => {
    void sessions.setPinned(chat.sessionId, !chat.pinned).catch(() => {});
  };

  const rename = async (sessionId: string, title: string | null): Promise<void> => {
    await sessions.rename(sessionId, title);
    void agents.refresh().catch(() => {});
  };
</script>

<section class="relative flex h-full min-w-0 flex-col" aria-label="Chat list">
  <header class="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3">
    <h2 class="min-w-0 flex-1 truncate text-xs font-semibold">{placeTitle}</h2>
    {#if onCollapse}
      <IconButton label="Hide chat list" onclick={onCollapse}><PanelLeftCloseIcon /></IconButton>
    {/if}
  </header>
  <div class="shrink-0 px-2 pb-2">
    <label class="relative block">
      <span class="sr-only">Search chats</span>
      <SearchIcon
        class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="search"
        placeholder="Search"
        value={search}
        oninput={(e) => onSearch(e.currentTarget.value)}
        onkeydown={onSearchKey}
        class="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-7 w-full rounded-md border bg-transparent pr-2 pl-7 text-xs outline-none focus-visible:ring-2"
      />
    </label>
  </div>

  {#if sessions.error}
    <p class="text-destructive px-3 pb-2 text-xs" role="alert">
      Could not load chats: {sessions.error}
    </p>
  {/if}

  {#snippet header(h: HeaderRow, pinned: boolean)}
    <div
      role="presentation"
      aria-hidden="true"
      data-section-header={h.section}
      data-sticky={pinned || undefined}
      class="bg-background text-muted-foreground flex h-full items-end gap-1.5 px-3.5 pb-1 text-[0.6875rem] leading-4 font-medium tracking-wide uppercase select-none"
    >
      <span class="min-w-0 truncate">{h.label}</span>
      <span class="shrink-0 font-normal tabular-nums">{h.count}{h.more ? '+' : ''}</span>
    </div>
  {/snippet}

  <!-- What each option's aria-describedby names: always present, unlike header rows. -->
  <div hidden>
    {#each headerSections as section (section)}
      <span id={sectionId(section)}>{SECTION_LABELS[section]}</span>
    {/each}
  </div>

  <VirtualList
    bind:this={list}
    bind:viewport
    items={grouped.rows}
    rowHeight={heightOf}
    key={(r) => r.key}
    isSticky={(r) => r.kind === 'header'}
    onEndReached={() => void sessions.loadMore()}
    role="listbox"
    aria-label="{placeTitle} chats"
    aria-activedescendant={cursorIndex >= 0 ? rowId(cursor!) : undefined}
    aria-busy={sessions.loading}
    tabindex={0}
    onkeydown={onListKey}
    class="focus-visible:ring-ring/50 min-h-0 flex-1 overflow-y-auto pb-1 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-inset"
  >
    {#snippet row(r)}
      {#if r.kind === 'header'}
        {@render header(r, false)}
      {:else}
        {@const chat = r.chat}
        <ChatListRow
          {chat}
          id={rowId(chat.sessionId)}
          index={r.index}
          setSize={grouped.chats.length}
          describedBy={sectionId(r.section)}
          selected={chat.sessionId === cursor}
          active={chat.sessionId === tabs.active}
          projectName={spansProjects
            ? (names.get(chat.projectId) ?? baseName(chat.cwd))
            : undefined}
          {now}
          running={chats.get(chat.sessionId)?.running ?? chat.runningTasks ?? 0}
          onOpen={open}
          onRename={(c) => (renaming = c)}
          onTogglePin={togglePin}
        />
      {/if}
    {/snippet}
    {#snippet sticky(r)}
      {#if r.kind === 'header'}
        {@render header(r, true)}
      {/if}
    {/snippet}
  </VirtualList>

  {#if sessions.items.length === 0 && !sessions.loading}
    <p
      class="text-muted-foreground pointer-events-none absolute inset-x-0 top-28 px-4 text-center text-xs"
    >
      {emptyText}
    </p>
  {/if}
</section>

<RenameDialog chat={renaming} onSubmit={rename} onClose={() => (renaming = null)} />

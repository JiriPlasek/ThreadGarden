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
  import VirtualList from './VirtualList.svelte';

  /** Middle column (spec §6.1): searchable, status-sorted chats of the selected place. */
  let { onCollapse }: { onCollapse?: () => void } = $props();

  const { sessions, places, tabs, agents, settings, chats } = useApp();

  /**
   * Fixed row height of the virtual list, in rem so it follows the interface
   * size: 3.25rem = 55 px at the 17 px base (a row's two lines take 2.375rem).
   */
  const ROW_REM = 3.25;
  const rowHeight = $derived(rowPx(ROW_REM, settings.scale));
  const PAGE_ROWS = 10;
  const SEARCH_DELAY_MS = 150;
  const CLOCK_MS = 30_000;

  let list = $state<ReturnType<typeof VirtualList<ChatSummary>> | null>(null);
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

  /** The keyboard cursor follows the active tab until the user moves it. */
  let cursor = $derived<string | null>(tabs.active);
  const cursorIndex = $derived(
    cursor === null ? -1 : sessions.items.findIndex((s) => s.sessionId === cursor),
  );

  const names = $derived(new Map(places.projects.map((p) => [p.projectId, p.displayName])));
  const spansProjects = $derived(places.selected.kind !== 'project');
  const placeTitle = $derived.by(() => {
    const p = places.selected;
    if (p.kind === 'needsYou') return 'Needs you';
    if (p.kind === 'running') return 'Running';
    if (p.kind === 'all') return 'All chats';
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

  const onSearch = (value: string): void => {
    search = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void sessions.setQuery(value.trim()), SEARCH_DELAY_MS);
  };

  const open = (chat: ChatSummary): void => {
    cursor = chat.sessionId;
    tabs.openTab(chat.sessionId);
  };

  const moveTo = (index: number): void => {
    const n = sessions.items.length;
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, index));
    cursor = sessions.items[i]!.sessionId;
    list?.scrollToIndex(i);
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
        moveTo(sessions.items.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const chat = sessions.items[i];
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

  <VirtualList
    bind:this={list}
    bind:viewport
    items={sessions.items}
    {rowHeight}
    key={(c) => c.sessionId}
    onEndReached={() => void sessions.loadMore()}
    role="listbox"
    aria-label="{placeTitle} chats"
    aria-activedescendant={cursorIndex >= 0 ? rowId(cursor!) : undefined}
    aria-busy={sessions.loading}
    tabindex={0}
    onkeydown={onListKey}
    class="focus-visible:ring-ring/50 min-h-0 flex-1 overflow-y-auto pb-1 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-inset"
  >
    {#snippet row(chat, i)}
      <ChatListRow
        {chat}
        id={rowId(chat.sessionId)}
        index={i}
        setSize={sessions.items.length}
        selected={chat.sessionId === cursor}
        active={chat.sessionId === tabs.active}
        projectName={spansProjects ? (names.get(chat.projectId) ?? baseName(chat.cwd)) : undefined}
        {now}
        running={chats.get(chat.sessionId)?.running ?? 0}
        onOpen={open}
        onRename={(c) => (renaming = c)}
        onTogglePin={togglePin}
      />
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

<script lang="ts">
  import type { Bucket } from '@threadgarden/protocol';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
  import SearchIcon from '@lucide/svelte/icons/search';
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '#lib/components/ui/button/index.js';
  import { rowPx } from '#lib/interface-scale.js';
  import { ARCHIVE_OLDER_DAYS } from '#lib/state/buckets.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { MergedList, type MachineChat } from '#lib/state/merged-list.svelte.js';
  import { includesOtherBuckets } from '#lib/state/places.svelte.js';
  import { chatKey } from '#lib/state/refs.js';
  import type { MachineScope } from '#lib/state/scope.js';
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
   *
   * Buckets (v1.2 §3): rows move to Active / On hold / Archived from their
   * context menu or with E (archive), H (hold) and A (make active). Ctrl/Cmd+
   * click toggles a chat in the multi-selection, Shift+click selects a range,
   * Ctrl/Cmd+A the cursor's section, Esc clears it; a bulk bar acts on it.
   * The Older header offers "Archive all older than 30 days" (also a Ctrl+K
   * command, as the header is hidden from assistive technology).
   *
   * Machines: once a machine is paired, Needs you, Running and the buckets
   * list every connected machine's chats (`MergedList`; a machine whose chats
   * are missing is named above the list); a project lists its machine's chats.
   * Rows are keyed by machine and session id, and act through their machine.
   * With This PC alone, the list is This PC's `sessions`, as always.
   */
  let { onCollapse }: { onCollapse?: () => void } = $props();

  const { sessions, places, tabs, agents, settings, machines, scopes } = useApp();
  const local = scopes.local();

  /** The scope of a machine (This PC's for a project without one). */
  const scopeOf = (machineId: string | undefined): MachineScope =>
    (machineId === undefined ? undefined : scopes.get(machineId)) ?? local;

  /** The selected project's machine; This PC for the cross-machine places. */
  const placeScope = $derived(
    places.selected.kind === 'project' ? scopeOf(places.selected.machineId) : local,
  );

  /** The cross-machine place's list while a machine is paired (else This PC's `sessions`). */
  let merged = $state<MergedList | null>(null);
  $effect(() => {
    const place = places.selected;
    if (place.kind === 'project' || scopes.all().length < 2) return;
    // Only the place and the set of machines make a new list (it follows the rest itself).
    return untrack(() => {
      const list = new MergedList(() => scopes.all(), place, { machines });
      list.query = sessions.query;
      merged = list;
      const stop = list.watch(scopes);
      void list.reload().catch(() => {});
      return () => {
        stop();
        merged = null;
      };
    });
  });

  // A project on another machine: that machine's `sessions` lists it.
  $effect(() => {
    const place = places.selected;
    const scope = placeScope;
    if (place.kind !== 'project' || scope === local) return;
    untrack(() => {
      scope.places.select(place);
      scope.places.setInclude(includesOtherBuckets(place));
    });
  });

  // The search box's query (This PC's `sessions.query`) applies to the list shown.
  $effect(() => {
    const query = sessions.query;
    const list = merged;
    const other = placeScope === local ? null : placeScope.sessions;
    if (list && list.query !== query) untrack(() => void list.setQuery(query).catch(() => {}));
    else if (!list && other && other.query !== query) {
      untrack(() => void other.setQuery(query).catch(() => {}));
    }
  });

  const shown = $derived(merged ?? placeScope.sessions);
  const items = $derived.by((): MachineChat[] => {
    if (merged) return merged.items;
    const machineId = placeScope.machineId;
    return placeScope.sessions.items.map((c) => ({ ...c, machineId }));
  });
  const hasMore = $derived(
    merged ? merged.nextAvailable : placeScope.sessions.nextCursor !== undefined,
  );
  const skipped = $derived(merged?.skipped ?? []);
  const keyOf = (chat: MachineChat): string => chatKey(chat);

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

  let list = $state<ReturnType<typeof VirtualList<ListRow<MachineChat>>> | null>(null);
  let viewport = $state<HTMLDivElement | null>(null);
  let search = $state(sessions.query);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let renaming = $state<MachineChat | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), CLOCK_MS);
    return () => {
      clearInterval(t);
      clearTimeout(searchTimer);
    };
  });

  /** The multi-selection (row keys) and where a Shift+click range starts. */
  const selection = new SvelteSet<string>();
  let anchor: string | null = null;

  // A different place or query is a different list: start at its top, nothing selected.
  $effect(() => {
    void places.selected;
    void sessions.query;
    untrack(() => {
      list?.scrollToTop();
      selection.clear();
      anchor = null;
    });
  });

  /** Sections move with the clock once a minute, not on every render or tick. */
  const minute = $derived(Math.floor(now / MINUTE_MS) * MINUTE_MS);
  const grouped = $derived(
    groupChats(items, minute, {
      // Every chat of these places is a "now" chat, whatever its status says by now.
      allNow: places.selected.kind === 'needsYou' || places.selected.kind === 'running',
      hasMore,
      keyOf,
    }),
  );

  /** The keyboard cursor (a row key) follows the active tab until the user moves it. */
  let cursor = $derived<string | null>(tabs.active);
  const cursorIndex = $derived(cursor === null ? -1 : (grouped.indexOf.get(cursor) ?? -1));

  /** The selected chats still listed, in display order. */
  const selectedChats = $derived(grouped.chats.filter((c) => selection.has(keyOf(c))));
  // Chats that left the list (archived from Active, …) leave the selection.
  $effect(() => {
    const listed = grouped.indexOf;
    untrack(() => {
      for (const id of [...selection]) if (!listed.has(id)) selection.delete(id);
    });
  });

  /** Project names by machine. */
  const namesOn = $derived(
    new Map(
      scopes
        .all()
        .map((s) => [
          s.machineId,
          new Map(s.places.projects.map((p) => [p.projectId, p.displayName])),
        ]),
    ),
  );
  const names = $derived(namesOn.get(placeScope.machineId) ?? new Map<string, string>());
  const projectNameOf = (chat: MachineChat): string =>
    namesOn.get(chat.machineId)?.get(chat.projectId) ?? baseName(chat.cwd);
  const spansProjects = $derived(places.selected.kind !== 'project');
  const placeTitle = $derived.by(() => {
    const p = places.selected;
    if (p.kind === 'needsYou') return 'Needs you';
    if (p.kind === 'running') return 'Running';
    if (p.kind === 'all' || p.kind === 'active') return 'Active';
    if (p.kind === 'onHold') return 'On hold';
    if (p.kind === 'archived') return 'Archived';
    return names.get(p.projectId) ?? 'Project';
  });
  const emptyText = $derived.by(() => {
    if (sessions.query) return `No chats match “${sessions.query}”`;
    const p = places.selected;
    if (p.kind === 'needsYou') return 'Nothing needs you right now.';
    if (p.kind === 'running') return 'No agents are working.';
    if (p.kind === 'onHold') return 'No chats on hold.';
    if (p.kind === 'archived') return 'No archived chats.';
    return 'No chats yet.';
  });
  const isProject = $derived(places.selected.kind === 'project');
  /** The Older section's tidy action applies to Active and to a project (not to a search). */
  const canArchiveOlder = $derived(
    !sessions.query &&
      (places.selected.kind === 'active' ||
        places.selected.kind === 'all' ||
        places.selected.kind === 'project'),
  );
  /** In Active, This PC's chats (each machine tidies its own). */
  const archiveOlder = (): void => {
    const p = places.selected;
    void placeScope.buckets.askArchiveOlder(p.kind === 'project' ? p.projectId : undefined);
  };

  /** This PC's rows keep their plain id; another machine's add the machine. */
  const rowId = (chat: MachineChat): string =>
    chat.machineId === local.machineId ? `chat-row-${chat.sessionId}` : `chat-row-${keyOf(chat)}`;
  const sectionId = (section: string): string => `chat-section-${section}`;
  const headerSections = $derived(
    grouped.rows.filter((r): r is HeaderRow => r.kind === 'header').map((r) => r.section),
  );

  const onSearch = (value: string): void => {
    search = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void sessions.setQuery(value.trim()), SEARCH_DELAY_MS);
  };

  const open = (chat: MachineChat): void => {
    cursor = keyOf(chat);
    tabs.openTab({ machineId: chat.machineId, sessionId: chat.sessionId });
  };

  const clearSelection = (): void => {
    selection.clear();
  };

  /** Selects the chats from `from` to `to` in display order (replacing the selection). */
  const selectRange = (from: string, to: string): void => {
    const b = grouped.indexOf.get(to);
    if (b === undefined) return;
    const a = grouped.indexOf.get(from) ?? b;
    selection.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      selection.add(keyOf(grouped.chats[i]!));
    }
  };

  /** A plain click opens; Ctrl/Cmd+click toggles the chat, Shift+click selects a range. */
  const onRowClick = (chat: MachineChat, e?: MouseEvent): void => {
    const id = keyOf(chat);
    if (e && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      cursor = id;
      anchor = id;
      if (selection.has(id)) selection.delete(id);
      else selection.add(id);
      return;
    }
    if (e?.shiftKey) {
      anchor ??= cursor ?? id;
      selectRange(anchor, id);
      cursor = id;
      return;
    }
    clearSelection();
    anchor = id;
    open(chat);
  };

  /**
   * Ctrl/Cmd+A: every chat of the cursor's section when the cursor is on
   * screen, else of the first section on screen (the first section of the
   * list without a cursor).
   */
  const selectSection = (): void => {
    const [top, bottom] = list?.visibleRows() ?? [0, grouped.rows.length - 1];
    const at = grouped.rowOf[cursorIndex];
    let index: number;
    if (at !== undefined && at >= top && at <= bottom) index = at;
    else {
      index = top;
      while (index < grouped.rows.length && grouped.rows[index]!.kind !== 'chat') index++;
    }
    const row = grouped.rows[index];
    if (!row || row.kind !== 'chat') return;
    selection.clear();
    for (const r of grouped.rows) {
      if (r.kind === 'chat' && r.section === row.section) selection.add(r.key);
    }
  };

  /** `targets` by machine, in the order the machines first appear. */
  const byMachine = (targets: MachineChat[]): [MachineScope, MachineChat[]][] => {
    const groups = new Map<string, MachineChat[]>();
    for (const t of targets) groups.set(t.machineId, [...(groups.get(t.machineId) ?? []), t]);
    return [...groups].map(([machineId, chats]) => [scopeOf(machineId), chats]);
  };

  /**
   * Moves chats to a bucket, each through its machine; On hold opens the hold
   * popover first. Moving the selection clears it (once the hold is saved, for On hold).
   */
  const move = (targets: MachineChat[], bucket: Bucket, fromSelection: boolean): void => {
    if (targets.length === 0) return;
    const groups = byMachine(targets);
    if (bucket === 'onHold') {
      for (const [scope, group] of groups) {
        scope.buckets.hold(group, fromSelection ? clearSelection : undefined);
      }
      return;
    }
    if (fromSelection) clearSelection();
    for (const [{ buckets }, group] of groups) {
      void (bucket === 'archived' ? buckets.archive(group) : buckets.activate(group));
    }
  };

  /** From the keyboard: the selection, or the chat under the cursor when nothing is selected. */
  const moveFromKeys = (bucket: Bucket): void => {
    if (selectedChats.length > 0) return move(selectedChats, bucket, true);
    const chat = grouped.chats[cursorIndex];
    if (chat) move([chat], bucket, false);
  };

  /** From a row's menu: the whole selection when the row is part of it. */
  const moveFromMenu = (chat: MachineChat, bucket: Bucket): void => {
    if (selection.has(keyOf(chat))) move(selectedChats, bucket, true);
    else move([chat], bucket, false);
  };

  const BUCKET_KEYS: Readonly<Record<string, Bucket>> = { e: 'archived', h: 'onHold', a: 'active' };

  /** Moves the cursor to the `index`-th chat (headers are not stops). */
  const moveTo = (index: number): void => {
    const n = grouped.chats.length;
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, index));
    cursor = keyOf(grouped.chats[i]!);
    list?.scrollToIndex(grouped.rowOf[i]!);
  };

  /** Shift+Space: adds the chat under the cursor to the selection, or removes it. */
  const toggleCursor = (): void => {
    const chat = grouped.chats[cursorIndex];
    if (!chat) return;
    const key = keyOf(chat);
    anchor = key;
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
  };

  const onListKey = (e: KeyboardEvent): void => {
    const i = cursorIndex;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === 'a') {
      e.preventDefault();
      selectSection();
      return;
    }
    const bucket = Object.hasOwn(BUCKET_KEYS, key) ? BUCKET_KEYS[key] : undefined;
    if (bucket) {
      // E, H and A alone: modified, they are someone else's shortcuts. A held
      // key repeats: only its first press counts (the selection it moved is
      // gone, the repeats would move the chat under the cursor).
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (!e.repeat) moveFromKeys(bucket);
      return;
    }
    if (e.key === ' ' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleCursor();
      return;
    }
    if (e.key === 'Escape') {
      if (selection.size === 0) return;
      e.preventDefault();
      clearSelection();
      return;
    }
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
        if (chat) {
          clearSelection();
          open(chat);
        }
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

  /** A merged list learns of a pin or a title from no event: it is fetched again. */
  const refetchMerged = (): void => {
    void merged?.refetch().catch(() => {});
  };

  const togglePin = (chat: MachineChat): void => {
    void scopeOf(chat.machineId)
      .sessions.setPinned(chat.sessionId, !chat.pinned)
      .then(refetchMerged)
      .catch(() => {});
  };

  const rename = async (chat: MachineChat, title: string | null): Promise<void> => {
    await scopeOf(chat.machineId).sessions.rename(chat.sessionId, title);
    refetchMerged();
    void agents.refresh().catch(() => {});
  };

  /** The rename dialog's chat (the dialog names it by session id only). */
  const renameRenaming = async (sessionId: string, title: string | null): Promise<void> => {
    const chat = renaming;
    if (chat?.sessionId === sessionId) await rename(chat, title);
  };

  /** Left/Right move between the bulk bar's buttons (toolbar keys). */
  const onBarKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = [...(e.currentTarget as HTMLElement).querySelectorAll('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.focus();
  };
</script>

<section class="relative flex h-full min-w-0 flex-col" aria-label="Chat list">
  <header class="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3">
    <h2 class="min-w-0 flex-1 truncate text-xs font-semibold">{placeTitle}</h2>
    {#if isProject}
      <IconButton
        label="Include on hold / archived"
        pressed={includesOtherBuckets(places.selected)}
        class="aria-pressed:bg-accent aria-pressed:text-foreground"
        onclick={() => places.setInclude(!includesOtherBuckets(places.selected))}
      >
        <LayersIcon />
      </IconButton>
    {/if}
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

  {#if shown.error}
    <p class="text-destructive px-3 pb-2 text-xs" role="alert">
      Could not load chats: {shown.error}
    </p>
  {/if}

  {#each skipped as name, i (i)}
    <p class="text-muted-foreground px-3 pb-2 text-xs" role="status">
      {name} is unreachable — its chats are missing here
    </p>
  {/each}

  {#if selectedChats.length > 0}
    <div
      role="toolbar"
      aria-label="Selected chats"
      tabindex="-1"
      class="bg-muted/60 mx-2 mb-2 flex shrink-0 items-center gap-0.5 rounded-md border py-0.5 pr-0.5 pl-2 text-xs"
      onkeydown={onBarKey}
    >
      <span class="min-w-0 flex-1 truncate font-medium tabular-nums"
        >{selectedChats.length} selected</span
      >
      <Button variant="ghost" size="xs" onclick={() => move(selectedChats, 'active', true)}
        >Make active</Button
      >
      <Button variant="ghost" size="xs" onclick={() => move(selectedChats, 'onHold', true)}
        >Put on hold…</Button
      >
      <Button variant="ghost" size="xs" onclick={() => move(selectedChats, 'archived', true)}
        >Archive</Button
      >
      <IconButton label="Clear selection" onclick={clearSelection}><XIcon /></IconButton>
    </div>
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
      {#if h.section === 'older' && canArchiveOlder}
        <!-- Pointer only (the header is hidden from assistive technology): Ctrl+K has the command. -->
        <button
          type="button"
          tabindex="-1"
          class="hover:text-foreground ml-auto shrink-0 rounded px-1 font-normal tracking-normal normal-case hover:underline"
          aria-label="Archive all older than {ARCHIVE_OLDER_DAYS} days"
          title="Archive all older than {ARCHIVE_OLDER_DAYS} days"
          onmousedown={(e) => e.preventDefault()}
          onclick={archiveOlder}>Archive all…</button
        >
      {/if}
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
    onEndReached={() => void shown.loadMore()}
    role="listbox"
    aria-label="{placeTitle} chats"
    aria-multiselectable="true"
    aria-activedescendant={cursorIndex >= 0 ? rowId(grouped.chats[cursorIndex]!) : undefined}
    aria-busy={shown.loading}
    tabindex={0}
    onkeydown={onListKey}
    class="focus-visible:ring-ring/50 min-h-0 flex-1 overflow-y-auto pb-1 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-inset"
  >
    {#snippet row(r)}
      {#if r.kind === 'header'}
        {@render header(r, false)}
      {:else}
        {@const chat = r.chat}
        {@const scope = scopeOf(chat.machineId)}
        <ChatListRow
          {chat}
          id={rowId(chat)}
          index={r.index}
          setSize={grouped.chats.length}
          describedBy={sectionId(r.section)}
          selected={selection.size > 0 ? selection.has(r.key) : r.key === cursor}
          checked={selection.has(r.key)}
          cursor={r.key === cursor}
          active={r.key === tabs.active}
          projectName={spansProjects ? projectNameOf(chat) : undefined}
          {now}
          running={scope.chats.get(chat.sessionId)?.running ?? chat.runningTasks ?? 0}
          scheduled={scope.scheduled.forChat(chat.sessionId)}
          onOpen={(_, e) => onRowClick(chat, e)}
          onRename={() => (renaming = chat)}
          onTogglePin={() => togglePin(chat)}
          onMove={(_, bucket) => moveFromMenu(chat, bucket)}
        />
      {/if}
    {/snippet}
    {#snippet sticky(r)}
      {#if r.kind === 'header'}
        {@render header(r, true)}
      {/if}
    {/snippet}
  </VirtualList>

  {#if items.length === 0 && !shown.loading}
    <p
      class="text-muted-foreground pointer-events-none absolute inset-x-0 top-28 px-4 text-center text-xs"
    >
      {emptyText}
    </p>
  {/if}
</section>

<RenameDialog chat={renaming} onSubmit={renameRenaming} onClose={() => (renaming = null)} />

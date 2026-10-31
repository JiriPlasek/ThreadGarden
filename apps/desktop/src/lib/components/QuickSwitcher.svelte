<script lang="ts" module>
  /** Chats shown per query. */
  export const QUICK_LIMIT = 20;
</script>

<script lang="ts">
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import GaugeIcon from '@lucide/svelte/icons/gauge';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import SearchIcon from '@lucide/svelte/icons/search';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import type { Component } from 'svelte';
  import ProjectIcon from '#lib/components/layout/ProjectIcon.svelte';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { useApp } from '#lib/state/context.js';
  import { formatShortcut, shortcut, type Combo } from '#lib/shortcuts.js';
  import { ARCHIVE_OLDER_DAYS } from '#lib/state/buckets.svelte.js';
  import { machineNameOf } from '#lib/state/machines.svelte.js';
  import { askArchiveOlderIn } from '#lib/state/merged-list.svelte.js';
  import { mergeQuickHits, type MachineHit } from '#lib/state/quick-search.js';
  import { chatKey } from '#lib/state/refs.js';
  import type { MachineScope } from '#lib/state/scope.js';
  import { cn } from '#lib/utils.js';

  /**
   * Ctrl/Cmd+K quick switcher (spec §6.1): searches chat titles, projects and
   * full text across all projects with one `search.quick` per keystroke (the
   * service answers within its 50 ms budget; an answer overtaken by a newer
   * query is dropped). Enter opens the chat or focuses its tab. Also hosts
   * commands: "New chat in…", "Stop all work", "Usage" (v1.3), "Analytics" (v1.3),
   * "Settings", "Keyboard shortcuts",
   * and in Active or a project "Archive chats older than 30 days…". Archived
   * matches come last, in their own "Archived" group (v1.2 §3).
   *
   * Machines: every connected machine is searched at once (`QUICK_LIMIT`
   * each), the answers merged by the service's score and cut to `QUICK_LIMIT`;
   * a hit opens on its machine, and carries a machine chip while more than one
   * machine is paired.
   */
  const { interaction, tabs, lifecycle, places, usage, scopes, machines } = useApp();

  type Command = {
    id: string;
    label: string;
    icon: Component;
    run: () => void;
    /** Shown at the end of the row: the key that does the same from anywhere. */
    keys?: Combo;
  };
  type Row = { key: string; hit: MachineHit; command?: never } | { key: string; command: Command };

  /** The tidy action applies to Active or to the selected project. */
  const archiveOlderCommand = $derived.by((): Command | null => {
    const p = places.selected;
    if (p.kind !== 'active' && p.kind !== 'all' && p.kind !== 'project') return null;
    return {
      id: 'archive-older',
      label: `Archive chats older than ${ARCHIVE_OLDER_DAYS} days…`,
      icon: ArchiveIcon,
      run: () => void askArchiveOlderIn(p, scopes),
    };
  });

  const COMMANDS: Command[] = [
    { id: 'new-chat', label: 'New chat in…', icon: PlusIcon, run: () => interaction.openNewChat() },
    {
      id: 'stop-all',
      label: 'Stop all work',
      icon: CircleStopIcon,
      run: () => (lifecycle.dialog = 'stopAll'),
    },
    { id: 'usage', label: 'Usage', icon: GaugeIcon, run: () => usage.open() },
    { id: 'analytics', label: 'Analytics', icon: ChartColumnIcon, run: () => tabs.showAnalytics() },
    {
      id: 'settings',
      label: 'Settings',
      icon: SettingsIcon,
      run: () => (interaction.settingsOpen = true),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: KeyboardIcon,
      run: () => (interaction.shortcutsOpen = true),
      keys: shortcut('shortcuts').combos[0],
    },
  ];

  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let hits = $state.raw<MachineHit[]>([]);
  let active = $state(0);
  /** The last query sent (trimmed): an edit that does not change it sends nothing. */
  let sent = '';
  /** Number of the newest request; older answers are dropped. */
  let latest = 0;

  const commands = $derived.by(() => {
    const all = archiveOlderCommand ? [...COMMANDS, archiveOlderCommand] : COMMANDS;
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  });
  const local = scopes.local();
  /** This PC's rows keep their plain key; another machine's add the machine. */
  const chatRow = (hit: MachineHit): Row => ({
    key: hit.machineId === local.machineId ? `chat:${hit.sessionId}` : `chat:${chatKey(hit)}`,
    hit,
  });
  /** Hits carry their machine's name while more than one machine is paired. */
  const multi = $derived(machines.list.length > 1);
  /** A hit's project icon comes from its machine. */
  const iconsOf = (machineId: string) => (scopes.get(machineId) ?? local).places.icons;

  /**
   * This PC's answer and every connected paired machine's, merged; a paired
   * machine that fails is left out (This PC failing fails the search, as before).
   */
  const quickSearch = async (q: string): Promise<MachineHit[]> => {
    const ask = async (s: MachineScope) => ({
      machineId: s.machineId,
      hits: await s.sessions.quickSearch(q, QUICK_LIMIT),
    });
    const others = scopes.all().filter((s) => s !== local && s.api.status === 'open');
    const [here, ...rest] = await Promise.allSettled([ask(local), ...others.map(ask)]);
    if (here!.status === 'rejected') throw here!.reason;
    const lists = [
      here!.value,
      ...rest.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : [])),
    ];
    return mergeQuickHits(lists, QUICK_LIMIT);
  };

  /** Chats, then commands; archived chats last (shown as their own group). */
  const main = $derived<Row[]>([
    ...hits.filter((h) => !h.archived).map(chatRow),
    ...commands.map((command) => ({ key: `cmd:${command.id}`, command })),
  ]);
  const archived = $derived<Row[]>(hits.filter((h) => h.archived).map(chatRow));
  const rows = $derived<Row[]>([...main, ...archived]);

  const search = (text: string): void => {
    const q = text.trim();
    if (q === sent) return;
    sent = q;
    const seq = ++latest;
    if (!q) {
      hits = [];
      return;
    }
    quickSearch(q).then(
      (items) => {
        if (seq !== latest) return;
        hits = items;
        active = 0;
      },
      () => {
        if (seq === latest) hits = [];
      },
    );
  };

  const reset = (): void => {
    query = '';
    hits = [];
    active = 0;
    sent = '';
    latest++;
  };

  const setOpen = (open: boolean): void => {
    if (open) reset();
    interaction.switcherOpen = open;
  };

  const choose = (row: Row | undefined): void => {
    if (!row) return;
    setOpen(false);
    if (row.command) row.command.run();
    else tabs.openTab({ machineId: row.hit.machineId, sessionId: row.hit.sessionId });
  };

  const optionId = (i: number): string => `quick-option-${i}`;

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    active = (active + delta + rows.length) % rows.length;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  };

  const onInput = (e: Event): void => {
    query = (e.currentTarget as HTMLInputElement).value;
    active = 0;
    search(query);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && !e.isComposing) choose(rows[active]);
    else return;
    e.preventDefault();
  };

  /** Ctrl/Cmd+K toggles the switcher from anywhere in the window. */
  const onWindowKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    setOpen(!interaction.switcherOpen);
  };
</script>

<svelte:window onkeydown={onWindowKey} />

<Dialog.Root open={interaction.switcherOpen} onOpenChange={setOpen}>
  <Dialog.Content
    showCloseButton={false}
    class="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
    onOpenAutoFocus={(e) => {
      e.preventDefault();
      input?.focus();
    }}
  >
    <Dialog.Title class="sr-only">Quick switcher</Dialog.Title>
    <Dialog.Description class="sr-only"
      >Search chats by title, project or text, or run a command.</Dialog.Description
    >
    <div class="flex items-center gap-2 border-b px-3">
      <SearchIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <input
        bind:this={input}
        role="combobox"
        aria-label="Search chats"
        aria-expanded="true"
        aria-controls="quick-list"
        aria-autocomplete="list"
        aria-activedescendant={rows.length > 0 ? optionId(active) : undefined}
        class="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
        placeholder="Search chats, projects and messages…"
        autocomplete="off"
        spellcheck="false"
        value={query}
        oninput={onInput}
        onkeydown={onKey}
      />
    </div>
    <ul
      id="quick-list"
      role="listbox"
      aria-label="Chats and commands"
      class="max-h-[min(60vh,28rem)] overflow-y-auto p-1 [scrollbar-width:thin]"
    >
      {#snippet option(row: Row, i: number)}
        <!-- Keyboard selection happens in the combobox (arrows, Enter); a click picks directly. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          data-key={row.key}
          role="option"
          aria-selected={i === active}
          class={cn(
            'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm',
            i === active && 'bg-accent text-accent-foreground',
          )}
          onmousemove={() => (active = i)}
          onclick={() => choose(row)}
        >
          {#if row.command}
            {@const Icon = row.command.icon}
            <Icon class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="truncate" data-label>{row.command.label}</span>
            {#if row.command.keys}
              <kbd
                class="bg-muted text-muted-foreground ml-auto shrink-0 rounded border px-1.5 font-sans text-xs leading-5"
                >{formatShortcut(row.command.keys)}</kbd
              >
            {/if}
          {:else}
            {#if row.hit.archived}
              <ArchiveIcon
                class="text-muted-foreground mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
            {:else}
              <MessageSquareIcon
                class="text-muted-foreground mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
            {/if}
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="flex min-w-0 items-baseline gap-2">
                <span class="truncate font-medium">{row.hit.title}</span>
                <span
                  class="text-muted-foreground ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 self-center text-xs"
                >
                  {#if multi}
                    <span class="bg-muted shrink-0 truncate rounded px-1 text-[0.6875rem]"
                      >{machineNameOf(machines, row.hit.machineId)}</span
                    >
                  {/if}
                  {#if row.hit.projectId}
                    <ProjectIcon
                      projectId={row.hit.projectId}
                      name={row.hit.projectName}
                      icons={iconsOf(row.hit.machineId)}
                    />
                  {/if}
                  <span class="truncate">{row.hit.projectName}</span>
                </span>
              </span>
              {#if row.hit.snippet}
                <span class="text-muted-foreground truncate text-xs">{row.hit.snippet}</span>
              {/if}
            </span>
          {/if}
        </li>
      {/snippet}
      {#each main as row, i (row.key)}
        {@render option(row, i)}
      {/each}
      {#if archived.length > 0}
        <li role="group" aria-label="Archived">
          <div aria-hidden="true" class="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">
            Archived
          </div>
          <ul role="presentation">
            {#each archived as row, j (row.key)}
              {@render option(row, main.length + j)}
            {/each}
          </ul>
        </li>
      {/if}
    </ul>
    {#if query.trim() && hits.length === 0 && commands.length === 0}
      <p class="text-muted-foreground px-3 pb-3 text-sm">No matching chats.</p>
    {/if}
  </Dialog.Content>
</Dialog.Root>

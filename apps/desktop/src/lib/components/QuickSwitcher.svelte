<script lang="ts" module>
  /** Chats shown per query. */
  export const QUICK_LIMIT = 20;
</script>

<script lang="ts">
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import SearchIcon from '@lucide/svelte/icons/search';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import type { Component } from 'svelte';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { useApp } from '#lib/state/context.js';
  import type { QuickHit } from '#lib/state/sessions.svelte.js';
  import { cn } from '#lib/utils.js';

  /**
   * Ctrl/Cmd+K quick switcher (spec §6.1): searches chat titles, projects and
   * full text across all projects with one `search.quick` per keystroke (the
   * service answers within its 50 ms budget; an answer overtaken by a newer
   * query is dropped). Enter opens the chat or focuses its tab. Also hosts
   * commands: "New chat in…", "Stop all work", "Settings".
   */
  const { interaction, sessions, tabs, lifecycle } = useApp();

  type Command = { id: string; label: string; icon: Component; run: () => void };
  type Row = { key: string; hit: QuickHit; command?: never } | { key: string; command: Command };

  const COMMANDS: Command[] = [
    { id: 'new-chat', label: 'New chat in…', icon: PlusIcon, run: () => interaction.openNewChat() },
    {
      id: 'stop-all',
      label: 'Stop all work',
      icon: CircleStopIcon,
      run: () => (lifecycle.dialog = 'stopAll'),
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: SettingsIcon,
      run: () => (interaction.settingsOpen = true),
    },
  ];

  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let hits = $state.raw<QuickHit[]>([]);
  let active = $state(0);
  /** The last query sent (trimmed): an edit that does not change it sends nothing. */
  let sent = '';
  /** Number of the newest request; older answers are dropped. */
  let latest = 0;

  const commands = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q)) : COMMANDS;
  });
  const rows = $derived<Row[]>([
    ...hits.map((hit) => ({ key: `chat:${hit.sessionId}`, hit })),
    ...commands.map((command) => ({ key: `cmd:${command.id}`, command })),
  ]);

  const search = (text: string): void => {
    const q = text.trim();
    if (q === sent) return;
    sent = q;
    const seq = ++latest;
    if (!q) {
      hits = [];
      return;
    }
    sessions.quickSearch(q, QUICK_LIMIT).then(
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
    else tabs.openTab(row.hit.sessionId);
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
      {#each rows as row, i (row.key)}
        <!-- Keyboard selection happens in the combobox (arrows, Enter); a click picks directly. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          data-key={row.key}
          role="option"
          aria-selected={i === active}
          class={cn(
            'flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-sm',
            i === active && 'bg-accent text-accent-foreground',
          )}
          onmousemove={() => (active = i)}
          onclick={() => choose(row)}
        >
          {#if row.command}
            {@const Icon = row.command.icon}
            <Icon class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{row.command.label}</span>
          {:else}
            <MessageSquareIcon
              class="text-muted-foreground mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="flex min-w-0 items-baseline gap-2">
                <span class="truncate font-medium">{row.hit.title}</span>
                <span class="text-muted-foreground ml-auto shrink-0 truncate text-xs"
                  >{row.hit.projectName}</span
                >
              </span>
              {#if row.hit.snippet}
                <span class="text-muted-foreground truncate text-xs">{row.hit.snippet}</span>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if query.trim() && hits.length === 0 && commands.length === 0}
      <p class="text-muted-foreground px-3 pb-3 text-sm">No matching chats.</p>
    {/if}
  </Dialog.Content>
</Dialog.Root>

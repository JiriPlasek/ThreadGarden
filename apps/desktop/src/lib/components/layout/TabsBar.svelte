<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus';
  import XIcon from '@lucide/svelte/icons/x';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import { shortcut } from '#lib/shortcuts.js';
  import { rawStatus, tabId } from './chat-info';
  import IconButton from './IconButton.svelte';
  import RunningBadge from './RunningBadge.svelte';
  import StatusIcon from './StatusIcon.svelte';

  /**
   * One tab per open chat (spec §6.1). Middle-click, the × button or Ctrl/Cmd+W
   * close a tab (every key is listed in `shortcuts.ts`); closing only drops the view, the session keeps running.
   * "+" (Ctrl/Cmd+N) starts a new chat, in the selected project if there is one.
   */
  const { tabs, chats, sessions, places, interaction } = useApp();

  const newChat = (): void => {
    const sel = places.selected;
    const project =
      sel.kind === 'project' ? places.projects.find((p) => p.projectId === sel.projectId) : null;
    interaction.openNewChat(project?.path ?? null);
  };

  const listed = $derived(new Map(sessions.items.map((s) => [s.sessionId, s])));

  const info = (sessionId: string) => {
    const chat = chats.get(sessionId);
    const listedSummary = listed.get(sessionId);
    // A background tab that was never shown has only a summary (see chats.sync).
    const peek = chat ? undefined : chats.summaryOf(sessionId);
    const summary = listedSummary ?? chat?.summary ?? peek ?? null;
    return {
      title: summary?.title ?? 'Loading…',
      status: chat?.loaded ? chat.status : (peek?.status ?? listedSummary?.status ?? 'history'),
      raw: rawStatus(summary),
      // Tasks are known for loaded chats only; closed or unseen tabs are never asked.
      running: chat?.running ?? 0,
    };
  };

  let tablist = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const active = tabs.active;
    if (!active || !tablist) return;
    tablist
      .querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  const focusTab = (sessionId: string): void => {
    tabs.activate(sessionId);
    tablist?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(sessionId)}"]`)?.focus();
  };

  const onTabsKey = (e: KeyboardEvent): void => {
    const i = tabs.active ? tabs.open.indexOf(tabs.active) : -1;
    const n = tabs.open.length;
    if (n === 0) return;
    let next: number;
    if (e.key === 'ArrowRight') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Delete' && tabs.active) {
      e.preventDefault();
      tabs.close(tabs.active);
      return;
    } else return;
    e.preventDefault();
    focusTab(tabs.open[next]!);
  };

  const onWindowKey = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey || e.defaultPrevented) return;
    // A modal dialog (rename, confirmation) owns the keyboard while it is open.
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      newChat();
    } else if (e.key.toLowerCase() === 'w' && !e.shiftKey && tabs.active) {
      e.preventDefault();
      tabs.close(tabs.active);
    } else if (e.key === 'Tab' && e.ctrlKey && tabs.open.length > 1) {
      e.preventDefault();
      const n = tabs.open.length;
      const i = tabs.active ? tabs.open.indexOf(tabs.active) : -1;
      tabs.activate(tabs.open[(i + (e.shiftKey ? -1 : 1) + n) % n]!);
    }
  };

  const onAux = (e: MouseEvent, sessionId: string): void => {
    if (e.button !== 1) return;
    e.preventDefault();
    tabs.close(sessionId);
  };
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="bg-muted/40 flex h-9 shrink-0 border-b">
  <div
    bind:this={tablist}
    role="tablist"
    aria-label="Open chats"
    tabindex="-1"
    class="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
    onkeydown={onTabsKey}
  >
    {#each tabs.open as sessionId (sessionId)}
      {@const t = info(sessionId)}
      {@const active = sessionId === tabs.active}
      <div
        role="presentation"
        class={cn(
          'group relative flex max-w-56 min-w-28 shrink-0 items-center border-r',
          active
            ? 'bg-background text-foreground after:bg-primary after:absolute after:inset-x-0 after:top-0 after:h-0.5'
            : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
        )}
      >
        <button
          type="button"
          role="tab"
          id={tabId(sessionId)}
          data-tab={sessionId}
          aria-selected={active}
          aria-controls="chat-panel"
          tabindex={active ? 0 : -1}
          title={t.title}
          class="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
          onclick={() => tabs.activate(sessionId)}
          onmousedown={(e) => e.button === 1 && e.preventDefault()}
          onauxclick={(e) => onAux(e, sessionId)}
        >
          <StatusIcon status={t.status} raw={t.raw} />
          <span class="truncate">{t.title}</span>
          {#if t.running > 0}
            <RunningBadge count={t.running} />
          {/if}
        </button>
        <IconButton
          label="Close {t.title}"
          shortcut={active ? shortcut('tab-close').combos[0] : undefined}
          tabindex={-1}
          class={cn(
            'mr-1 size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            active && 'opacity-60',
          )}
          onclick={() => tabs.close(sessionId)}
          onauxclick={(e) => onAux(e, sessionId)}
        >
          <XIcon class="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
    {/each}
  </div>
  <div class="flex w-9 shrink-0 items-center justify-center">
    <IconButton label="New chat" shortcut={shortcut('new-chat').combos[0]} onclick={newChat}>
      <PlusIcon />
    </IconButton>
  </div>
</div>

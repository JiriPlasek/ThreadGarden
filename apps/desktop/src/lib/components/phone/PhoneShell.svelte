<script lang="ts">
  import { untrack } from 'svelte';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ChatList from '#lib/components/layout/ChatList.svelte';
  import ChatPane from '#lib/components/layout/ChatPane.svelte';
  import PlacesColumn from '#lib/components/layout/PlacesColumn.svelte';
  import { onOpenChat as nativeOnOpenChat } from '#lib/native.js';
  import { useApp } from '#lib/state/context.js';
  import type { ChatRef } from '#lib/state/refs.js';
  import { phoneNav, type PhoneNavState } from '#lib/state/phone-nav.svelte.js';
  import { chatTitle } from './chat-title';
  import PhoneNav from './PhoneNav.svelte';
  import RecentChats from './RecentChats.svelte';

  /**
   * The phone's layout (spec "The screens"): one column at a time, from the
   * machines and places to a place's chats to a chat, each a level of
   * `PhoneNavState` (Back, the on-screen one or the gesture, goes up one).
   * Tabs become Recent chats. The desktop's columns, strip and tabs aren't
   * used; the stores and dialogs are the same.
   *
   * The software keyboard resizes the page (`interactive-widget`, and the
   * visual viewport's height where a webview ignores it), so the composer
   * stays above it. Interactive elements are at least 44 px (`data-phone`,
   * layout.css).
   */
  /**
   * Clear of Android's status bar, gesture bar and a cutout (the app draws
   * edge to edge). MainActivity pads the webview by the system's insets, so
   * these read 0 there; a webview drawn under the bars says their size in
   * `safe-area-inset-*`, and `--sat`, `--sar`, `--sab` and `--sal` can be
   * set from outside for one that doesn't.
   */
  const SAFE_PADDING = (['top', 'right', 'bottom', 'left'] as const)
    .map((side) => `max(env(safe-area-inset-${side}, 0px), var(--sa${side[0]}, 0px))`)
    .join(' ');

  let {
    nav = phoneNav,
    onOpenChat = nativeOnOpenChat,
  }: {
    nav?: PhoneNavState;
    /** Where an opened alert asks for its chat (the core's event). */
    onOpenChat?: typeof nativeOnOpenChat;
  } = $props();

  const { connection, tabs, places, scopes, interaction } = useApp();

  /** New chat in the selected project, on its machine (as the desktop's "+"). */
  const newChat = (): void => {
    const sel = places.selected;
    const scope = sel.kind === 'project' && sel.machineId ? scopes.get(sel.machineId) : undefined;
    const project =
      sel.kind === 'project'
        ? scope?.places.projects.find((p) => p.projectId === sel.projectId)
        : null;
    interaction.openNewChat(project?.path ?? null, scope?.machineId ?? null);
  };

  /** The chat on screen's title, in the phone bar (the chat's own header has no room for it). */
  const title = $derived(tabs.active ? chatTitle(scopes, tabs.active) : '');

  /**
   * An alert opened: its chat, at the chat level, also when it is already the
   * active tab (the tabs don't change, so nothing else would show it).
   */
  const showChat = (ref: ChatRef): void => {
    tabs.openTab(ref);
    nav.go('chat');
  };
  $effect(() => {
    let off: (() => void) | undefined;
    let stopped = false;
    void onOpenChat(showChat).then((f) => (stopped ? f() : (off = f)));
    return () => {
      stopped = true;
      off?.();
    };
  });

  /**
   * An open dialog (New chat, Recent chats, Settings, Move to…, a
   * confirmation) has a history entry: Back closes it, as Escape does, and the
   * level stays. Closed by itself, its entry goes.
   */
  $effect(() => {
    const OPEN = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
    let open = false;
    const check = (): void => {
      const now = document.querySelector(OPEN) !== null;
      if (now === open) return;
      open = now;
      if (now) nav.dialogOpened();
      else nav.dialogClosed();
    };
    nav.onCloseDialogs(() => {
      const top = [...document.querySelectorAll<HTMLElement>(OPEN)].at(-1);
      top?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    check();
    return () => observer.disconnect();
  });

  /**
   * A chat opened from anywhere (New chat, Recent chats, a list) is shown; the
   * last one closed goes back to the list. The tabs restored at start don't
   * count: the app opens on the places.
   */
  let seen: string | null | undefined;
  $effect(() => {
    const active = tabs.active;
    if (!tabs.restored) return;
    untrack(() => {
      if (seen === undefined || active === seen) {
        seen = active;
        return;
      }
      seen = active;
      if (active) nav.go('chat');
      else if (nav.level === 'chat') nav.go('list');
    });
  });

  // Phone-only styles (touch targets), the keyboard resizing the page, and its height.
  $effect(() => {
    const root = document.documentElement;
    root.dataset.phone = '';
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = meta?.content;
    // `viewport-fit=cover`: a webview drawn under the system bars reports their size.
    if (meta) {
      meta.content =
        'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
    }
    const vv = window.visualViewport;
    const fit = (): void => {
      if (vv) root.style.setProperty('--phone-vh', `${vv.height}px`);
    };
    fit();
    vv?.addEventListener('resize', fit);
    return () => {
      vv?.removeEventListener('resize', fit);
      delete root.dataset.phone;
      root.style.removeProperty('--phone-vh');
      if (meta && before !== undefined) meta.content = before;
    };
  });
</script>

<div
  class="bg-background text-foreground flex flex-col overflow-hidden"
  style:height="var(--phone-vh, 100dvh)"
  style:padding={SAFE_PADDING}
  data-phone-shell
  data-level={nav.level}
>
  {#if connection.status === 'reconnecting'}
    <div
      role="status"
      class="shrink-0 bg-amber-500/15 px-3 py-1 text-xs text-amber-900 dark:text-amber-200"
    >
      Reconnecting to the Threadgarden service…
    </div>
  {/if}

  {#if nav.level === 'places'}
    <div class="bg-sidebar text-sidebar-foreground min-h-0 flex-1">
      <PlacesColumn onSelect={() => nav.go('list')} />
    </div>
  {:else if nav.level === 'list'}
    <PhoneNav back="Places" onBack={nav.up}>
      {#snippet actions()}
        <button
          type="button"
          class="hover:bg-accent text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-md"
          aria-label="New chat"
          onclick={newChat}
        >
          <PlusIcon class="size-5" aria-hidden="true" />
        </button>
      {/snippet}
    </PhoneNav>
    <div class="min-h-0 flex-1">
      <ChatList onOpen={() => nav.go('chat')} />
    </div>
  {:else}
    <PhoneNav back="Chats" onBack={nav.up} {title}>
      {#snippet actions()}
        <RecentChats />
      {/snippet}
    </PhoneNav>
    <main class="flex min-h-0 flex-1 flex-col">
      <ChatPane />
    </main>
  {/if}
</div>

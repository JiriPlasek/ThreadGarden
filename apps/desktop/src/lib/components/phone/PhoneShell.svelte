<script lang="ts">
  import { untrack } from 'svelte';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ChatList from '#lib/components/layout/ChatList.svelte';
  import ChatPane from '#lib/components/layout/ChatPane.svelte';
  import PlacesColumn from '#lib/components/layout/PlacesColumn.svelte';
  import { useApp } from '#lib/state/context.js';
  import { phoneNav, type PhoneNavState } from '#lib/state/phone-nav.svelte.js';
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
  let { nav = phoneNav }: { nav?: PhoneNavState } = $props();

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
    if (meta)
      meta.content = 'width=device-width, initial-scale=1, interactive-widget=resizes-content';
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
  style="height: var(--phone-vh, 100dvh)"
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
    <PhoneNav back="Chats" onBack={nav.up}>
      {#snippet actions()}
        <RecentChats />
      {/snippet}
    </PhoneNav>
    <main class="flex min-h-0 flex-1 flex-col">
      <ChatPane />
    </main>
  {/if}
</div>

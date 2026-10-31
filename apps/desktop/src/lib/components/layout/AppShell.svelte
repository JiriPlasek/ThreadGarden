<script lang="ts" module>
  /** Column geometry in px; widths are user-resizable within [min, max] and remembered. */
  export const COLUMNS = {
    places: { initial: 220, min: 160, max: 360 },
    list: { initial: 340, min: 240, max: 560 },
  } as const;
  type Column = keyof typeof COLUMNS;
</script>

<script lang="ts">
  import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
  import BucketDialogs from '#lib/components/BucketDialogs.svelte';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import KeyboardShortcutsDialog from '#lib/components/KeyboardShortcutsDialog.svelte';
  import NewChatDialog from '#lib/components/NewChatDialog.svelte';
  import QuickSwitcher from '#lib/components/QuickSwitcher.svelte';
  import ServiceBanner from '#lib/components/ServiceBanner.svelte';
  import SettingsDialog from '#lib/components/SettingsDialog.svelte';
  import SetupScreen from '#lib/components/SetupScreen.svelte';
  import UsageDialog from '#lib/components/UsageDialog.svelte';
  import { scaleKeyAction } from '#lib/interface-scale.js';
  import { useApp } from '#lib/state/context.js';
  import AgentsStrip from './AgentsStrip.svelte';
  import ChatList from './ChatList.svelte';
  import ChatPane from './ChatPane.svelte';
  import IconButton from './IconButton.svelte';
  import PlacesColumn from './PlacesColumn.svelte';
  import Resizable from './Resizable.svelte';
  import TabsBar from './TabsBar.svelte';

  /**
   * Main window (spec §6.1): places | chat list | open chat with tabs, and the
   * running-agents strip along the bottom. The first two columns resize and collapse.
   * Without a usable Claude Code the setup screen comes first (spec §6.4); the
   * user can still browse history without it. Ctrl/Cmd+K opens the quick
   * switcher from anywhere, Ctrl/Cmd+/ the keyboard shortcuts, and Ctrl/Cmd
   * with = + - 0 changes the interface size; an older service shows the
   * restart banner.
   */
  const { settings, connection, places, interaction } = useApp();

  let checking = $state(false);
  const checkAgain = (): void => {
    checking = true;
    interaction
      .loadStatus()
      .catch(() => {})
      .finally(() => (checking = false));
  };

  /**
   * A file dropped anywhere but the composer must never navigate the webview
   * to that file (the chat would be lost). Composers handle their own drops.
   */
  const isFileDrag = (e: DragEvent): boolean =>
    [...(e.dataTransfer?.types ?? [])].includes('Files');
  const cancelFileDrag = (e: DragEvent): void => {
    if (isFileDrag(e)) e.preventDefault();
  };

  /** Interface size keys; the webview's own zoom must not react as well. */
  const onWindowKey = (e: KeyboardEvent): void => {
    const action = scaleKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === 'reset') settings.setScale(1);
    else settings.stepScale(action === 'up' ? 1 : -1);
  };

  const width = (c: Column): number => {
    const { initial, min, max } = COLUMNS[c];
    const w = settings.columnWidths[c] ?? initial;
    return Math.min(max, Math.max(min, w));
  };
  const collapsed = (c: Column): boolean => settings.collapsed[c] === true;
</script>

<svelte:window ondragover={cancelFileDrag} ondrop={cancelFileDrag} onkeydown={onWindowKey} />

<div class="bg-background text-foreground flex h-screen flex-col overflow-hidden">
  {#if connection.status === 'reconnecting'}
    <div
      role="status"
      class="shrink-0 bg-amber-500/15 px-3 py-1 text-xs text-amber-900 dark:text-amber-200"
    >
      Reconnecting to the Threadgarden service…
    </div>
  {:else}
    <ServiceBanner />
  {/if}

  {#if interaction.claudeMissing && !interaction.setupDismissed}
    <main class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
      <SetupScreen
        kind="missing"
        problem={interaction.status?.claude.problem}
        {checking}
        onRetry={checkAgain}
        onDismiss={() => (interaction.setupDismissed = true)}
      />
    </main>
  {:else}
    <div class="flex min-h-0 flex-1">
      {#if collapsed('places')}
        <div class="bg-sidebar flex w-9 shrink-0 flex-col items-center gap-1 border-r py-1.5">
          <IconButton
            label="Show places"
            side="right"
            onclick={() => settings.setCollapsed('places', false)}
          >
            <PanelLeftOpenIcon />
          </IconButton>
          <IconButton
            label="Settings"
            side="right"
            onclick={() => (interaction.settingsOpen = true)}
          >
            <SettingsIcon />
          </IconButton>
          {#if places.counts.needsYou > 0}
            <button
              type="button"
              class="rounded-full bg-amber-500/20 px-1.5 text-[0.6875rem] leading-4 font-medium text-amber-800 tabular-nums dark:text-amber-300"
              title="Needs you"
              aria-label="Needs you: {places.counts.needsYou}"
              onclick={() => places.select({ kind: 'needsYou' })}>{places.counts.needsYou}</button
            >
          {/if}
        </div>
      {:else}
        <aside
          class="bg-sidebar text-sidebar-foreground shrink-0"
          style:width="{width('places')}px"
        >
          <PlacesColumn onCollapse={() => settings.setCollapsed('places', true)} />
        </aside>
        <Resizable
          label="Resize places"
          width={width('places')}
          {...COLUMNS.places}
          onChange={(w) => settings.setColumnWidth('places', w)}
        />
      {/if}

      {#if collapsed('list')}
        <div class="flex w-9 shrink-0 flex-col items-center border-r py-1.5">
          <IconButton
            label="Show chat list"
            side="right"
            onclick={() => settings.setCollapsed('list', false)}
          >
            <PanelLeftOpenIcon />
          </IconButton>
        </div>
      {:else}
        <div class="shrink-0" style:width="{width('list')}px">
          <ChatList onCollapse={() => settings.setCollapsed('list', true)} />
        </div>
        <Resizable
          label="Resize chat list"
          width={width('list')}
          {...COLUMNS.list}
          onChange={(w) => settings.setColumnWidth('list', w)}
        />
      {/if}

      <main class="flex min-w-0 flex-1 flex-col">
        <TabsBar />
        <ChatPane />
      </main>
    </div>

    <AgentsStrip />
  {/if}
</div>

<NewChatDialog />
<QuickSwitcher />
<SettingsDialog />
<KeyboardShortcutsDialog />
<BucketDialogs />
<UsageDialog />

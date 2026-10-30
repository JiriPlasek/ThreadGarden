<script lang="ts">
  import type { Place, Project } from '@pahub/protocol';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import * as ContextMenu from '#lib/components/ui/context-menu/index.js';
  import { samePlace } from '#lib/state/places.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import IconButton from './IconButton.svelte';
  import StatusIcon from './StatusIcon.svelte';

  /** Left column (spec §6.1): smart folders with counts, then projects (pinned, then recent). */
  let { onCollapse }: { onCollapse?: () => void } = $props();

  const { places, interaction } = useApp();

  let showHidden = $state(false);

  const byPinnedThenRecent = (a: Project, b: Project): number =>
    Number(b.pinned) - Number(a.pinned) ||
    b.lastActivity - a.lastActivity ||
    a.displayName.localeCompare(b.displayName);

  const visible = $derived(places.projects.filter((p) => !p.hidden).sort(byPinnedThenRecent));
  const hidden = $derived(
    places.projects
      .filter((p) => p.hidden)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  const isSelected = (place: Place): boolean => samePlace(places.selected, place);
  const select = (place: Place): void => places.select(place);
  const quiet = (p: Promise<unknown>): void => void p.catch(() => {});

  const itemClass = (selected: boolean): string =>
    cn(
      'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none',
      'hover:bg-sidebar-accent/70 focus-visible:ring-ring/50 focus-visible:ring-2',
      selected && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
    );
</script>

{#snippet badge(count: number, tone: 'amber' | 'green' | 'muted', label: string)}
  {#if count > 0}
    <span
      class={cn(
        'ml-auto shrink-0 rounded-full px-1.5 text-[11px] leading-4 font-medium tabular-nums',
        tone === 'amber' && 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
        tone === 'green' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        tone === 'muted' && 'text-muted-foreground font-normal',
      )}
      title={label}>{count}</span
    >
  {/if}
{/snippet}

{#snippet projectItem(project: Project)}
  {@const place = { kind: 'project', projectId: project.projectId } as const}
  <li>
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class={itemClass(isSelected(place))}
            aria-current={isSelected(place) ? 'true' : undefined}
            title={project.path}
            onclick={() => select(place)}
          >
            {#if project.pinned}
              <PinIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            {:else}
              <FolderIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            {/if}
            <span class="min-w-0 truncate">{project.displayName}</span>
            {#if project.counts.needsYou > 0}
              {@render badge(project.counts.needsYou, 'amber', 'Needs you')}
            {:else}
              {@render badge(project.counts.running, 'green', 'Working')}
            {/if}
          </button>
        {/snippet}
      </ContextMenu.Trigger>
      <ContextMenu.Content class="min-w-40">
        <ContextMenu.Item
          class="py-1 text-xs"
          onSelect={() => quiet(places.pinProject(project.projectId, !project.pinned))}
        >
          {#if project.pinned}<PinOffIcon /> Unpin project{:else}<PinIcon /> Pin project{/if}
        </ContextMenu.Item>
        <ContextMenu.Item
          class="py-1 text-xs"
          onSelect={() => quiet(places.hideProject(project.projectId, !project.hidden))}
        >
          {#if project.hidden}<EyeIcon /> Show project{:else}<EyeOffIcon /> Hide project{/if}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  </li>
{/snippet}

<nav class="flex h-full min-w-0 flex-col" aria-label="Places">
  <header class="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3">
    <span class="flex-1 text-sm font-semibold tracking-tight">pahub</span>
    <IconButton label="Settings" onclick={() => (interaction.settingsOpen = true)}>
      <SettingsIcon />
    </IconButton>
    {#if onCollapse}
      <IconButton label="Hide places" onclick={onCollapse}><PanelLeftCloseIcon /></IconButton>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:thin]">
    <ul class="space-y-px">
      <li>
        <button
          type="button"
          class={itemClass(isSelected({ kind: 'needsYou' }))}
          aria-current={isSelected({ kind: 'needsYou' }) ? 'true' : undefined}
          onclick={() => select({ kind: 'needsYou' })}
        >
          <StatusIcon status="needsYou" decorative class="mx-px" />
          <span class="truncate">Needs you</span>
          {@render badge(places.counts.needsYou, 'amber', 'Chats waiting for you')}
        </button>
      </li>
      <li>
        <button
          type="button"
          class={itemClass(isSelected({ kind: 'running' }))}
          aria-current={isSelected({ kind: 'running' }) ? 'true' : undefined}
          onclick={() => select({ kind: 'running' })}
        >
          <StatusIcon status="working" decorative class="mx-px" />
          <span class="truncate">Running</span>
          {@render badge(places.counts.running, 'green', 'Working agents')}
        </button>
      </li>
      <li>
        <button
          type="button"
          class={itemClass(isSelected({ kind: 'all' }))}
          aria-current={isSelected({ kind: 'all' }) ? 'true' : undefined}
          onclick={() => select({ kind: 'all' })}
        >
          <InboxIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate">All chats</span>
          {@render badge(places.counts.all, 'muted', 'All chats')}
        </button>
      </li>
    </ul>

    <h3
      class="text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase"
      id="places-projects"
    >
      Projects
    </h3>
    {#if visible.length === 0}
      <p class="text-muted-foreground px-2 text-xs">No projects yet.</p>
    {/if}
    <ul class="space-y-px" aria-labelledby="places-projects">
      {#each visible as project (project.projectId)}
        {@render projectItem(project)}
      {/each}
    </ul>

    {#if hidden.length > 0}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground mt-3 flex h-6 items-center gap-1 px-2 text-[11px]"
        aria-expanded={showHidden}
        onclick={() => (showHidden = !showHidden)}
      >
        <ChevronRightIcon
          class={cn('size-3 transition-transform', showHidden && 'rotate-90')}
          aria-hidden="true"
        />
        Hidden projects ({hidden.length})
      </button>
      {#if showHidden}
        <ul class="space-y-px opacity-80">
          {#each hidden as project (project.projectId)}
            {@render projectItem(project)}
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</nav>

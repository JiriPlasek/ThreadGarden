<script lang="ts">
  import type { Place, Project } from '@pahub/protocol';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import FolderXIcon from '@lucide/svelte/icons/folder-x';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
  import PinIcon from '@lucide/svelte/icons/pin';
  import PinOffIcon from '@lucide/svelte/icons/pin-off';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import * as ContextMenu from '#lib/components/ui/context-menu/index.js';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { samePlace } from '#lib/state/places.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import IconButton from './IconButton.svelte';
  import ProjectIcon from './ProjectIcon.svelte';
  import StatusIcon from './StatusIcon.svelte';

  /**
   * Left column (spec §6.1): smart folders with counts (Needs you, Running,
   * and the buckets Active, On hold and Archived, v1.2 §3), then projects in
   * the service's order (pinned, then recent activity). Projects whose folder
   * is gone sit in a collapsed "Missing folders" group below them (v1.1 §4).
   * Each project shows its icon or a letter tile (v1.3 §5), a pinned one a pin.
   */
  let { onCollapse }: { onCollapse?: () => void } = $props();

  const { places, interaction } = useApp();

  let showHidden = $state(false);
  /** The "Hide all missing" confirmation is open (v1.2 §4). */
  let hidingMissing = $state(false);
  /** Where focus goes after "Hide all missing": its own button is gone by then. */
  let hiddenToggle = $state<HTMLButtonElement | null>(null);

  const MISSING_WHY = 'Claude Code still has these chats, but their folders were deleted.';

  /** `exists` is optional for a service without it: such folders count as present. */
  const isMissing = (p: Project): boolean => p.exists === false;

  const visible = $derived(places.projects.filter((p) => !p.hidden && !isMissing(p)));
  const missing = $derived(places.projects.filter((p) => !p.hidden && isMissing(p)));
  const hidden = $derived(
    places.projects
      .filter((p) => p.hidden)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  /** The bucket places (v1.2 §3); Active replaces "All chats" (`all` from an older service). */
  const BUCKETS = [
    {
      kind: 'active',
      label: 'Active',
      title: 'Active chats',
      icon: InboxIcon,
      count: () => places.counts.active ?? places.counts.all,
    },
    {
      kind: 'onHold',
      label: 'On hold',
      title: 'Chats on hold',
      icon: PauseIcon,
      count: () => places.counts.onHold ?? 0,
    },
    {
      kind: 'archived',
      label: 'Archived',
      title: 'Archived chats',
      icon: ArchiveIcon,
      count: () => places.counts.archived ?? 0,
    },
  ] as const;

  const isSelected = (place: Place): boolean => samePlace(places.selected, place);
  const select = (place: Place): void => places.select(place);
  const quiet = (p: Promise<unknown>): void => void p.catch(() => {});

  const itemClass = (selected: boolean): string =>
    cn(
      'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] outline-none',
      'hover:bg-sidebar-accent/70 focus-visible:ring-ring/50 focus-visible:ring-2',
      selected && 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
    );
</script>

{#snippet badge(count: number, tone: 'amber' | 'green' | 'muted', label: string)}
  {#if count > 0}
    <span
      class={cn(
        'ml-auto shrink-0 rounded-full px-1.5 text-[0.6875rem] leading-4 font-medium tabular-nums',
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
            title={isMissing(project) ? `${project.path} (folder not found)` : project.path}
            onclick={() => select(place)}
          >
            {#if isMissing(project)}
              <FolderXIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            {:else}
              <ProjectIcon projectId={project.projectId} name={project.displayName} />
            {/if}
            <span class="min-w-0 truncate">{project.displayName}</span>
            {#if project.pinned}
              <PinIcon class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
            {/if}
            {#if project.counts.needsYou > 0}
              <!-- The service counts unread chats ("Your turn") here too. -->
              {@render badge(project.counts.needsYou, 'amber', 'Needs you or your turn')}
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
      {#each BUCKETS as b (b.kind)}
        {@const place = { kind: b.kind }}
        <li>
          <button
            type="button"
            class={itemClass(isSelected(place))}
            aria-current={isSelected(place) ? 'true' : undefined}
            onclick={() => select(place)}
          >
            <b.icon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{b.label}</span>
            {@render badge(b.count(), 'muted', b.title)}
          </button>
        </li>
      {/each}
    </ul>

    <h3
      class="text-muted-foreground px-2 pt-4 pb-1 text-[0.6875rem] font-medium tracking-wide uppercase"
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

    {#if missing.length > 0}
      <div class="mt-3 flex items-center gap-1 pr-1">
        <Tooltip.Provider delayDuration={400}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="text-muted-foreground hover:text-foreground flex h-6 min-w-0 flex-1 items-center gap-1 px-2 text-left text-[0.6875rem]"
                  aria-expanded={places.missingOpen}
                  aria-describedby="places-missing-why"
                  onclick={() => places.setMissingOpen(!places.missingOpen)}
                >
                  <ChevronRightIcon
                    class={cn(
                      'size-3.5 shrink-0 transition-transform',
                      places.missingOpen && 'rotate-90',
                    )}
                    aria-hidden="true"
                  />
                  <span class="truncate">Missing folders ({missing.length})</span>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="right" class="max-w-60 px-2 py-1">{MISSING_WHY}</Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
        <span id="places-missing-why" hidden>{MISSING_WHY}</span>
        <IconButton label="Hide all missing" side="right" onclick={() => (hidingMissing = true)}>
          <EyeOffIcon />
        </IconButton>
      </div>
      {#if places.missingOpen}
        <ul class="space-y-px opacity-80" aria-label="Missing folders">
          {#each missing as project (project.projectId)}
            {@render projectItem(project)}
          {/each}
        </ul>
      {/if}
    {/if}

    {#if hidden.length > 0}
      <button
        bind:this={hiddenToggle}
        type="button"
        class="text-muted-foreground hover:text-foreground mt-3 flex h-6 items-center gap-1 px-2 text-[0.6875rem]"
        aria-expanded={showHidden}
        onclick={() => (showHidden = !showHidden)}
      >
        <ChevronRightIcon
          class={cn('size-3.5 transition-transform', showHidden && 'rotate-90')}
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

<ConfirmDialog
  bind:open={hidingMissing}
  title="Hide all missing folders?"
  description="{missing.length === 1
    ? '1 project'
    : `${missing.length} projects`} whose folder was deleted will move to Hidden projects. Their chats stay in Claude Code, and you can show the projects again from there."
  confirmLabel={missing.length === 1 ? 'Hide 1 project' : `Hide ${missing.length} projects`}
  onConfirm={() => places.hideProjects(missing.map((p) => p.projectId))}
  focusAfterConfirm={() => hiddenToggle}
/>

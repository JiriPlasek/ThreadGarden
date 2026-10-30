<script lang="ts">
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import { baseName, externalLabel, previewLine, rawStatus } from './chat-info';
  import StatusIcon, { statusLabel } from './StatusIcon.svelte';

  /**
   * Bottom strip (spec §6.1, Ruling R21): every live pahub chat and every active
   * external session from every project, needs-you → working → idle. Clicking one
   * opens (or focuses) its tab. "Stop all work" (enabled while any pahub chat is
   * live; it closes idle ones too) sits behind a confirmation.
   */
  const { agents, tabs, places } = useApp();

  let confirming = $state(false);

  const names = $derived(new Map(places.projects.map((p) => [p.projectId, p.displayName])));
  const canStop = $derived(agents.items.some((a) => a.live));
</script>

<footer class="bg-muted/40 flex h-8 shrink-0 items-center gap-2 border-t pr-1 pl-2 text-xs">
  {#if agents.items.length === 0}
    <span class="text-muted-foreground flex-1 truncate">No agents running</span>
  {:else}
    <ul
      class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      aria-label="Running agents"
    >
      {#each agents.items as agent (agent.sessionId)}
        {@const project = names.get(agent.projectId) ?? baseName(agent.cwd)}
        {@const detail = previewLine(agent)}
        <li class="shrink-0">
          <button
            type="button"
            class={cn(
              'hover:bg-accent focus-visible:ring-ring/50 flex h-6 max-w-60 items-center gap-1.5 rounded px-2 outline-none focus-visible:ring-2',
              agent.sessionId === tabs.active && 'bg-accent text-accent-foreground',
            )}
            title={`${agent.title} · ${project} · ${statusLabel(agent.status, rawStatus(agent))}${
              detail ? ` · ${detail}` : ''
            }`}
            onclick={() => tabs.openTab(agent.sessionId)}
          >
            <StatusIcon status={agent.status} raw={rawStatus(agent)} />
            <span class="truncate">{agent.title}</span>
            <span class="text-muted-foreground max-w-24 shrink-0 truncate">{project}</span>
            {#if agent.external}
              <span role="img" aria-label={externalLabel(agent)} class="text-muted-foreground">
                <SquareTerminalIcon class="size-3.5" aria-hidden="true" />
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <Button
    variant="ghost"
    size="xs"
    class="text-muted-foreground hover:text-destructive shrink-0"
    disabled={!canStop}
    onclick={() => (confirming = true)}
  >
    <CircleStopIcon aria-hidden="true" />
    Stop all work
  </Button>
</footer>

<ConfirmDialog
  bind:open={confirming}
  title="Stop all work?"
  description="Every chat running in pahub is interrupted and closed. Sessions running in a terminal are not affected, and any chat can be resumed later."
  confirmLabel="Stop all work"
  destructive
  onConfirm={async () => {
    await agents.stopAll();
  }}
/>

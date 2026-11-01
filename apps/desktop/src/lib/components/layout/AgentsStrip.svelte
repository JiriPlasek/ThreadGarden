<script lang="ts">
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { useApp } from '#lib/state/context.js';
  import { stopAllDescription } from '#lib/state/lifecycle.svelte.js';
  import { machineNameOf, onMachineNames } from '#lib/state/machines.svelte.js';
  import { chatKey } from '#lib/state/refs.js';
  import type { MachineScope } from '#lib/state/scope.js';
  import { cn } from '#lib/utils.js';
  import { baseName, externalLabel, previewLine, rawStatus } from './chat-info';
  import RunningBadge from './RunningBadge.svelte';
  import StatusIcon, { statusLabel } from './StatusIcon.svelte';
  import UsageMeter from './UsageMeter.svelte';
  import UpdateNotice from '#lib/components/UpdateNotice.svelte';

  /**
   * Bottom strip (spec §6.1, Ruling R21): every live Threadgarden chat and every active
   * external session from every project, needs-you → working → idle. Clicking one
   * opens (or focuses) its tab; a chat with running background tasks shows its
   * "N running" pill (Ruling R29). "Stop all work" (enabled while any Threadgarden chat is
   * live; it closes idle ones too) sits behind a confirmation. v1.3 B: the
   * usage meter sits before it (hidden while nothing is known). With paired
   * machines, every connected machine's agents are listed (each opens on its
   * machine), and "Stop all work" stops the work of every connected machine.
   */
  const { agents, tabs, scopes, machines } = useApp();
  const local = scopes.local();

  let confirming = $state(false);

  const scopeOf = (machineId: string): MachineScope => scopes.get(machineId) ?? local;
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
  const canStop = $derived(agents.items.some((a) => a.live));
  /** Agents carry their machine's name while more than one machine is paired. */
  const multi = $derived(machines.several);
</script>

<footer class="bg-muted/40 flex h-8 shrink-0 items-center gap-2 border-t pr-1 pl-2 text-xs">
  {#if agents.items.length === 0}
    <span class="text-muted-foreground flex-1 truncate">No agents running</span>
  {:else}
    <ul
      class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      aria-label="Running agents"
    >
      {#each agents.items as agent (chatKey(agent))}
        {@const project = namesOn.get(agent.machineId)?.get(agent.projectId) ?? baseName(agent.cwd)}
        {@const detail = previewLine(agent)}
        {@const running =
          scopeOf(agent.machineId).chats.get(agent.sessionId)?.running ?? agent.runningTasks ?? 0}
        <li class="shrink-0">
          <button
            type="button"
            class={cn(
              'hover:bg-accent focus-visible:ring-ring/50 flex h-6 max-w-60 items-center gap-1.5 rounded px-2 outline-none focus-visible:ring-2',
              chatKey(agent) === tabs.active && 'bg-accent text-accent-foreground',
            )}
            title={[
              agent.title,
              ...(multi ? [machineNameOf(machines, agent.machineId)] : []),
              project,
              statusLabel(agent.status, rawStatus(agent), agent.unread),
              ...(detail ? [detail] : []),
            ].join(' · ')}
            onclick={() => tabs.openTab({ machineId: agent.machineId, sessionId: agent.sessionId })}
          >
            <StatusIcon status={agent.status} raw={rawStatus(agent)} unread={agent.unread} />
            <span class="truncate">{agent.title}</span>
            {#if multi}
              <span class="bg-muted max-w-24 shrink-0 truncate rounded px-1 text-[0.6875rem]"
                >{machineNameOf(machines, agent.machineId)}</span
              >
            {/if}
            <span class="text-muted-foreground max-w-24 shrink-0 truncate">{project}</span>
            {#if running > 0}
              <RunningBadge count={running} />
            {/if}
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
  <UpdateNotice />
  <UsageMeter />
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
  description={stopAllDescription(onMachineNames(machines))}
  confirmLabel="Stop all work"
  destructive
  onConfirm={async () => {
    await agents.stopAll();
  }}
/>

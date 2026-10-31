<script lang="ts">
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { onTray, type TrayEvent } from '#lib/native.js';
  import { useApp } from '#lib/state/context.js';
  import type { ServiceAction } from '#lib/state/lifecycle.svelte.js';

  /**
   * The lifecycle confirmations (spec §4.2): "Stop all work…" and "Quit Threadgarden
   * completely…" from the tray menu (and the quick switcher), and "Restart
   * service" from the version banner. Each lists the Threadgarden agents it stops.
   * "Quit Threadgarden (keep agents running)" needs no confirmation: the shell exits.
   */
  const { lifecycle, connection } = useApp();

  const TRAY: [TrayEvent, ServiceAction][] = [
    ['stop-all', 'stopAll'],
    ['quit-all', 'quitAll'],
  ];

  $effect(() => {
    let stopped = false;
    const offs: (() => void)[] = [];
    for (const [event, action] of TRAY) {
      void onTray(event, () => (lifecycle.dialog = action)).then((off) =>
        stopped ? off() : offs.push(off),
      );
    }
    return () => {
      stopped = true;
      for (const off of offs) off();
    };
  });

  /** Two-way binding of one dialog's `open` to `lifecycle.dialog`. */
  const opener = (action: ServiceAction) => ({
    get: () => lifecycle.dialog === action,
    set: (open: boolean) => {
      if (open) lifecycle.dialog = action;
      else if (lifecycle.dialog === action) lifecycle.dialog = null;
    },
  });
  const stopAll = opener('stopAll');
  const quitAll = opener('quitAll');
  const restart = opener('restart');
</script>

{#snippet agentsToStop()}
  {@const running = lifecycle.running}
  {#if connection.status === 'incompatible'}
    <p class="text-muted-foreground text-sm">
      Threadgarden can't list the agents of a service with another protocol; any it runs are stopped.
    </p>
  {:else if running.length === 0}
    <p class="text-muted-foreground text-sm">No agents are running in Threadgarden.</p>
  {:else}
    <div class="text-sm">
      <p class="text-muted-foreground mb-1">
        {running.length === 1 ? '1 agent is' : `${running.length} agents are`} running:
      </p>
      <ul
        aria-label="Agents to stop"
        class="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 [scrollbar-width:thin]"
      >
        {#each running as agent (agent.sessionId)}
          <li class="truncate" title={agent.title}>{agent.title}</li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<ConfirmDialog
  bind:open={stopAll.get, stopAll.set}
  title="Stop all work?"
  description="Every chat running in Threadgarden is interrupted and closed, with its background agents and processes. Sessions running in a terminal are not affected, and any chat can be resumed later."
  confirmLabel="Stop all work"
  destructive
  onConfirm={lifecycle.stopAll}
>
  {@render agentsToStop()}
</ConfirmDialog>

<ConfirmDialog
  bind:open={quitAll.get, quitAll.set}
  title="Quit Threadgarden completely?"
  description="Stops every chat running in Threadgarden, then the Threadgarden service, then closes the app. Sessions running in a terminal are not affected."
  confirmLabel="Quit completely"
  destructive
  onConfirm={lifecycle.quitCompletely}
>
  {@render agentsToStop()}
</ConfirmDialog>

<ConfirmDialog
  bind:open={restart.get, restart.set}
  title="Restart the Threadgarden service?"
  description={`The service is replaced by the version that comes with this app${
    connection.appVersion ? ` (${connection.appVersion})` : ''
  }. Every chat running in Threadgarden is stopped first; you can resume them afterwards.`}
  confirmLabel="Restart service"
  destructive
  onConfirm={lifecycle.restartService}
>
  {@render agentsToStop()}
</ConfirmDialog>

<script lang="ts">
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import { Button } from '#lib/components/ui/button/index.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * "Restart the pahub service to update" (spec §4.2, ruling R18). Blocking:
   * the service speaks another protocol, so nothing works until it restarts.
   * Otherwise a thin bar, shown while an older (or newer) service of the same
   * protocol is running. Either way pahub never restarts it on its own while
   * agents may run: **Restart service** asks first (`ServiceDialogs`).
   */
  let { blocking = false }: { blocking?: boolean } = $props();

  const { connection, lifecycle } = useApp();

  const restart = (): void => {
    lifecycle.dialog = 'restart';
  };
</script>

{#if blocking}
  <main class="flex min-h-screen items-center justify-center p-8">
    <div role="alert" class="flex max-w-md flex-col items-start gap-3">
      <h1 class="text-base font-semibold">The pahub service is an older version</h1>
      <p class="text-muted-foreground text-sm" data-testid="status">
        It speaks a different protocol than this app, so pahub cannot use it. Restart the pahub
        service to update; chats it runs can be resumed afterwards.
      </p>
      <Button size="sm" onclick={restart}>
        <RefreshCwIcon aria-hidden="true" /> Restart service
      </Button>
    </div>
  </main>
{:else if connection.restartNeeded}
  <div
    role="status"
    class="bg-muted text-muted-foreground flex shrink-0 items-center gap-2 px-3 py-1 text-xs"
  >
    <span class="text-foreground font-medium"
      >{connection.serviceNewer
        ? 'The pahub service is a newer version'
        : 'The pahub service is an older version'}</span
    >
    <span class="min-w-0 truncate"
      >({connection.serviceVersion}; this app is {connection.appVersion}). Restart the pahub service
      to update.</span
    >
    <Button variant="outline" size="xs" class="ml-auto shrink-0" onclick={restart}>
      <RefreshCwIcon aria-hidden="true" /> Restart service
    </Button>
  </div>
{/if}

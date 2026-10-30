<script lang="ts">
  import { startApp } from '#lib/state/app.js';
  import { connection } from '#lib/state/connection.svelte.js';

  let failure = $state<string | null>(null);

  const describe = (err: unknown): string => {
    const text = err instanceof Error ? err.message : String(err);
    return text === 'service-version-mismatch' || text === 'Incompatible protocol version'
      ? 'Restart the pahub service to update.'
      : `Could not reach the pahub service: ${text}`;
  };

  $effect(() => {
    startApp().catch((err: unknown) => (failure = describe(err)));
  });
</script>

<main class="flex min-h-screen items-center justify-center p-8">
  {#if failure}
    <p class="text-destructive" data-testid="status">{failure}</p>
  {:else if connection.status === 'open'}
    <p data-testid="status">
      pahub service {connection.serviceVersion}{connection.restartNeeded
        ? ' (restart the pahub service to update)'
        : ''}
    </p>
  {:else if connection.status === 'incompatible'}
    <p class="text-destructive" data-testid="status">Restart the pahub service to update.</p>
  {:else}
    <p class="text-muted-foreground" data-testid="status">
      {connection.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
    </p>
  {/if}
</main>

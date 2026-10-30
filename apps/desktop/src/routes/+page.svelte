<script lang="ts">
  import { serviceConnection } from '#lib/native.js';
  import { fetchHello } from '#lib/service/hello.js';

  type Status =
    | { kind: 'connecting' }
    | { kind: 'connected'; version: string }
    | { kind: 'failed'; message: string };

  let status = $state<Status>({ kind: 'connecting' });

  const describe = (err: unknown): string => {
    const text = err instanceof Error ? err.message : String(err);
    return text === 'service-version-mismatch'
      ? 'Restart the pahub service to update.'
      : `Could not reach the pahub service: ${text}`;
  };

  $effect(() => {
    serviceConnection()
      .then((conn) => fetchHello(conn))
      .then((hello) => (status = { kind: 'connected', version: hello.serviceVersion }))
      .catch((err: unknown) => (status = { kind: 'failed', message: describe(err) }));
  });
</script>

<main class="flex min-h-screen items-center justify-center p-8">
  {#if status.kind === 'connecting'}
    <p class="text-muted-foreground" data-testid="status">Connecting…</p>
  {:else if status.kind === 'connected'}
    <p data-testid="status">pahub service {status.version}</p>
  {:else}
    <p class="text-destructive" data-testid="status">{status.message}</p>
  {/if}
</main>

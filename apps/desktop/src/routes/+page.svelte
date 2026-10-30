<script lang="ts">
  import AppShell from '#lib/components/layout/AppShell.svelte';
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

  /** After the first successful connection the layout stays up; drops show a banner. */
  const ready = $derived(connection.status === 'open' || connection.status === 'reconnecting');
</script>

{#if failure}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-destructive text-sm" data-testid="status">{failure}</p>
  </main>
{:else if connection.status === 'incompatible'}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-destructive text-sm" data-testid="status">
      Restart the pahub service to update.
    </p>
  </main>
{:else if ready}
  <AppShell />
{:else}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-muted-foreground text-sm" data-testid="status">Connecting…</p>
  </main>
{/if}

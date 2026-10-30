<script lang="ts">
  import AppShell from '#lib/components/layout/AppShell.svelte';
  import ServiceBanner from '#lib/components/ServiceBanner.svelte';
  import ServiceDialogs from '#lib/components/ServiceDialogs.svelte';
  import { startApp } from '#lib/state/app.js';
  import { connection } from '#lib/state/connection.svelte.js';

  let failure = $state<string | null>(null);

  /** The shell or the client found a service that speaks another protocol. */
  const isMismatch = (text: string): boolean =>
    text === 'service-version-mismatch' || text === 'Incompatible protocol version';

  $effect(() => {
    startApp().catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      if (isMismatch(text)) connection.markIncompatible();
      else failure = `Could not reach the pahub service: ${text}`;
    });
  });

  /** After the first successful connection the layout stays up; drops show a banner. */
  const ready = $derived(connection.status === 'open' || connection.status === 'reconnecting');
</script>

{#if connection.status === 'incompatible'}
  <ServiceBanner blocking />
{:else if ready}
  <AppShell />
{:else if failure}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-destructive text-sm" data-testid="status">{failure}</p>
  </main>
{:else}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-muted-foreground text-sm" data-testid="status">Connecting…</p>
  </main>
{/if}

<!-- Tray actions and "Restart service" confirmations, whatever the window shows. -->
<ServiceDialogs />

<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AppShell from '#lib/components/layout/AppShell.svelte';
  import ServiceBanner from '#lib/components/ServiceBanner.svelte';
  import ServiceDialogs from '#lib/components/ServiceDialogs.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { startApp } from '#lib/state/app.js';
  import { connection } from '#lib/state/connection.svelte.js';
  import { isPhone } from '#lib/native.js';
  import { phoneNav } from '#lib/state/phone-nav.svelte.js';

  let failure = $state<string | null>(null);

  /** The shell or the client found a service that speaks another protocol. */
  const isMismatch = (text: string): boolean =>
    text === 'service-version-mismatch' || text === 'Incompatible protocol version';

  /** Connects to (or starts) the service; a failure offers Retry, never a dead end. */
  const start = (): void => {
    failure = null;
    startApp().catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      if (isMismatch(text)) connection.markIncompatible();
      else failure = `Could not reach the Threadgarden service: ${text}`;
    });
  };

  onMount(start);

  /**
   * The phone's levels are history entries (shallow routing), so the back
   * gesture, which goes back in the webview, moves up one level; from the top
   * it leaves the app as usual. Only Back (popstate) moves the level here.
   */
  if (isPhone) {
    let pushes = Promise.resolve();
    let popped = false;
    phoneNav.bind({
      // One at a time: a chat opened from the places pushes its list first.
      push: (level) => {
        pushes = pushes
          .then(() => goto(page.url.href, { state: { phone: level }, shallow: true }))
          .catch(() => {});
      },
      back: (steps) => history.go(-steps),
    });
    onMount(() => {
      const onPop = (): void => {
        popped = true;
      };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    });
    $effect(() => {
      const level = page.state.phone;
      if (!popped) return;
      popped = false;
      phoneNav.shown(level);
    });
  }

  /** After the first successful connection the layout stays up; drops show a banner. */
  const ready = $derived(connection.status === 'open' || connection.status === 'reconnecting');
</script>

{#if connection.status === 'incompatible'}
  <ServiceBanner blocking />
{:else if ready}
  <AppShell />
{:else if failure}
  <main class="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
    <p class="text-destructive max-w-prose text-center text-sm" data-testid="status">{failure}</p>
    <Button size="sm" onclick={start}>Retry</Button>
  </main>
{:else}
  <main class="flex min-h-screen items-center justify-center p-8">
    <p class="text-muted-foreground text-sm" data-testid="status">Connecting…</p>
  </main>
{/if}

<!-- Tray actions and "Restart service" confirmations, whatever the window shows. -->
<ServiceDialogs />

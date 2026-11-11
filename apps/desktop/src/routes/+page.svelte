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
   * The phone's levels (and an open dialog) are history entries (shallow
   * routing), so the back gesture, which goes back in the webview, moves up
   * one level or closes the dialog; from the top it leaves the app as usual.
   * The entries change one at a time, each after the one before has landed.
   */
  if (isPhone) {
    let queue = Promise.resolve();
    let popped = false;
    const then = (step: () => Promise<void>): void => {
      queue = queue.then(step).catch(() => {});
    };
    const traversed = (): Promise<void> =>
      new Promise((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true }),
      );
    phoneNav.bind({
      push: (level, o) =>
        then(() =>
          goto(page.url.href, {
            state: { phone: level, ...(o?.dialog ? { dialog: true } : {}) },
            shallow: true,
          }),
        ),
      replace: (level) =>
        then(() => goto(page.url.href, { state: { phone: level }, shallow: true, replace: true })),
      back: (steps) =>
        then(async () => {
          const done = traversed();
          history.go(-steps);
          await done;
        }),
    });
    onMount(() => {
      const onPop = (): void => {
        popped = true;
      };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    });
    $effect(() => {
      const state = page.state;
      if (!popped) return;
      popped = false;
      phoneNav.popped(state.phone);
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

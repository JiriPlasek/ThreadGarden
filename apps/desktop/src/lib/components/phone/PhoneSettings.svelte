<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import { appVersion, keepAlive, type KeepAliveStatus } from '#lib/native.js';

  /**
   * Settings → This phone: whether it stays connected to the machines (the
   * notification's Disconnect, and Connect again), whether Android lets it
   * run in the background (the battery exemption, asked through Android's own
   * dialog), and this app's version.
   */
  let status = $state<KeepAliveStatus | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const read = async (): Promise<void> => {
    try {
      status = await keepAlive.status();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  };

  $effect(() => {
    void read();
    // Back from Android's dialog, the answer is known.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  const act = async (step: () => Promise<void>): Promise<void> => {
    busy = true;
    error = null;
    try {
      await step();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      await read();
    }
  };
</script>

<section class="grid gap-2 border-t pt-3 text-sm" aria-labelledby="settings-this-phone">
  <h3 id="settings-this-phone" class="text-muted-foreground text-xs font-medium">This phone</h3>
  {#if status}
    <div class="flex flex-wrap items-center gap-2">
      <span class="min-w-0 flex-1">
        {status.connected
          ? 'Connected to your machines'
          : 'Disconnected: no alerts until you connect again'}
      </span>
      {#if status.connected}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onclick={() => act(keepAlive.disconnect)}>Disconnect</Button
        >
      {:else}
        <Button size="sm" disabled={busy} onclick={() => act(keepAlive.connect)}>Connect</Button>
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if status.batteryExempt}
        <span class="text-muted-foreground">Allowed to run in the background.</span>
      {:else}
        <span class="min-w-0 flex-1">
          Android may stop Threadgarden in the background to save battery, and alerts then come
          late.
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onclick={() => act(keepAlive.requestBatteryExemption)}>Allow in the background</Button
        >
      {/if}
    </div>
    {#if !status.notificationsAllowed}
      <p class="text-muted-foreground">
        Notifications are off for Threadgarden: allow them in Android's settings to get alerts.
      </p>
    {/if}
  {/if}
  <p class="text-muted-foreground">Threadgarden {appVersion}</p>
  {#if error}<p class="text-destructive text-xs" role="alert">{error}</p>{/if}
</section>

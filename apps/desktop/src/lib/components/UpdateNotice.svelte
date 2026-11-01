<script lang="ts">
  import DownloadIcon from '@lucide/svelte/icons/download';
  import XIcon from '@lucide/svelte/icons/x';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { openExternal } from '#lib/native.js';
  import { useApp } from '#lib/state/context.js';
  import { RELEASES_URL, updateStops } from '#lib/state/updates.svelte.js';

  /**
   * The bottom strip's update notice (releases spec §6): quiet, dismissible,
   * never a popup. Restarting to update asks first when it would stop work on
   * This PC; deb and rpm installs get a download link instead.
   */
  const { updates, lifecycle, scheduled } = useApp();

  let confirming = $state(false);

  const version = $derived(updates.available?.version ?? '');
  const releaseUrl = $derived(`${RELEASES_URL}/tag/v${version}`);
  const shown = $derived(
    updates.available !== null &&
      !updates.dismissed &&
      (updates.phase === 'available' ||
        updates.phase === 'downloading' ||
        updates.phase === 'ready' ||
        updates.phase === 'installing'),
  );
  const busy = $derived(updates.phase !== 'available');
  const pendingSends = $derived(scheduled.items.filter((s) => s.state === 'pending').length);

  const restart = (): void => {
    if (lifecycle.running.length > 0 || pendingSends > 0) confirming = true;
    else void updates.install();
  };
</script>

{#if shown}
  <div class="flex shrink-0 items-center gap-1" role="status">
    {#if updates.phase === 'downloading'}
      <span class="text-muted-foreground">Downloading update… {updates.progress ?? 0}%</span>
    {:else if busy}
      <span class="text-muted-foreground">Installing update…</span>
    {:else}
      {#if updates.lastError}
        <span class="text-destructive" role="alert">{updates.lastError}</span>
      {:else}
        <span>Threadgarden {version} is available.</span>
      {/if}
      {#if updates.canSelfUpdate}
        <Button variant="ghost" size="xs" onclick={restart}>Restart to update</Button>
      {:else}
        <Button variant="ghost" size="xs" onclick={() => void openExternal(releaseUrl)}>
          <DownloadIcon aria-hidden="true" />
          Download
        </Button>
      {/if}
      <Button variant="ghost" size="xs" onclick={() => void openExternal(releaseUrl)}>
        What's new
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss update notice"
        onclick={() => updates.dismiss()}
      >
        <XIcon aria-hidden="true" />
      </Button>
    {/if}
  </div>
{/if}

<ConfirmDialog
  bind:open={confirming}
  title="Update and restart?"
  description={updateStops(
    lifecycle.running.map((c) => c.title),
    pendingSends,
  )}
  confirmLabel="Update and restart"
  onConfirm={() => {
    // The dialog closes at once; the strip shows the download and any error.
    void updates.install();
  }}
/>

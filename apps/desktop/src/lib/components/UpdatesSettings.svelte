<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import { agoText } from '#lib/format/usage.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * Settings → Updates (releases spec §6): this version, the last check, a
   * manual check and what it found. The update notice itself lives in the
   * bottom strip.
   */
  const { updates } = useApp();

  const checking = $derived(updates.phase === 'checking');
</script>

<section class="grid gap-1 border-t pt-3 text-xs" aria-labelledby="settings-updates">
  <h3 id="settings-updates" class="text-muted-foreground font-medium">Updates</h3>
  {#if updates.phase === 'unsupported'}
    <p class="text-muted-foreground">Updates are installed by the app build you run.</p>
  {:else}
    <p>Version {updates.current}</p>
    <p class="text-muted-foreground">
      {updates.lastCheck === null
        ? 'Not checked yet'
        : `Last checked ${agoText(updates.lastCheck, Date.now())}`}
    </p>
    {#if updates.lastError}
      <p class="text-destructive" role="alert">{updates.lastError}</p>
    {:else if updates.available}
      <p>Threadgarden {updates.available.version} is available.</p>
    {:else if updates.lastCheck !== null}
      <p>You're up to date.</p>
    {/if}
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={checking}
        onclick={() => void updates.check({ manual: true })}
      >
        {checking ? 'Checking…' : 'Check for updates'}
      </Button>
    </div>
  {/if}
</section>

<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '#lib/components/ui/button/index.js';
  import { appVersion, openExternal } from '#lib/native.js';
  import { compareVersions } from '#lib/state/connection.svelte.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * The phone's update notice: its core asks GitHub for the latest release
   * (`update.latest`; the webview's CSP keeps it from asking itself), once
   * each time the app starts. A newer release with an APK shows
   * "Threadgarden ‹version› is available" and Download, which opens the APK's
   * address in the browser: nothing is downloaded or installed here. The same
   * version, or a check that failed, shows nothing.
   */
  const { scopes } = useApp();
  const api = scopes.local().api;

  let latest = $state<{ version: string; url: string } | null>(null);
  let dismissed = $state(false);

  $effect(() => {
    let live = true;
    api
      .request('update.latest', {})
      .then(({ version, url }) => {
        if (live && url && compareVersions(version, appVersion) > 0) latest = { version, url };
      })
      .catch(() => {
        // Offline, or GitHub didn't answer: the next start asks again.
      });
    return () => {
      live = false;
    };
  });
</script>

{#if latest && !dismissed}
  <div role="status" class="bg-muted flex shrink-0 items-center gap-2 border-b px-3 py-1 text-sm">
    <span class="min-w-0 flex-1">Threadgarden {latest.version} is available</span>
    <Button size="sm" variant="outline" onclick={() => void openExternal(latest!.url)}
      >Download</Button
    >
    <button
      type="button"
      class="text-muted-foreground hover:bg-accent flex size-11 shrink-0 items-center justify-center rounded-md"
      aria-label="Dismiss update notice"
      onclick={() => (dismissed = true)}
    >
      <XIcon class="size-4" aria-hidden="true" />
    </button>
  </div>
{/if}

<script lang="ts">
  import { onMount } from 'svelte';
  import { pickFolder } from '#lib/native.js';
  import type { ProjectsApi } from '#lib/projects.js';
  import FolderBrowser from './FolderBrowser.svelte';

  /**
   * The "Create in" folder of a new project or a clone: the machine's
   * remembered place (asked each time the field appears), typed, or picked
   * with Browse… (the native picker on This PC, the folder browser elsewhere).
   */
  let {
    value = $bindable(),
    api,
    onThisPc,
    machineName,
    home,
  }: {
    value: string;
    /** The chosen machine's projects methods. */
    api: ProjectsApi;
    onThisPc: boolean;
    machineName: string;
    home: string | null;
  } = $props();

  let browsing = $state(false);

  onMount(() => {
    // An answer after this field is gone (another machine chosen) is dropped:
    // a bound prop would still write it into the dialog.
    let live = true;
    const before = value;
    api
      .createIn()
      .then((path) => {
        // A place typed meanwhile wins.
        if (live && value === before) value = path;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const browse = async (): Promise<void> => {
    if (!onThisPc) {
      browsing = true;
      return;
    }
    const path = await pickFolder();
    if (path) value = path;
  };
</script>

<div class="grid gap-1">
  <label for="create-in" class="text-muted-foreground text-xs">Create in</label>
  <div class="flex gap-2">
    <input
      id="create-in"
      class="bg-background h-8 w-full min-w-0 rounded-md border px-2 font-mono text-sm"
      spellcheck="false"
      autocomplete="off"
      bind:value
    />
    <button
      type="button"
      class="hover:bg-muted h-8 shrink-0 rounded-md border px-3 text-sm"
      onclick={() => void browse()}>Browse…</button
    >
  </div>
</div>

{#if browsing}
  <FolderBrowser
    {api}
    {machineName}
    start={value || home || '~'}
    onPick={(path) => {
      browsing = false;
      value = path;
    }}
    onCancel={() => (browsing = false)}
  />
{/if}

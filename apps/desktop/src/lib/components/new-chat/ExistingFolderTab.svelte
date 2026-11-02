<script lang="ts">
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
  import { isTauri, pickFolder } from '#lib/native.js';
  import type { ProjectsApi } from '#lib/projects.js';
  import FolderBrowser from './FolderBrowser.svelte';

  /**
   * New chat's Existing folder tab: the machine's folders, and Browse… for
   * any other (the native picker on This PC, the folder browser elsewhere).
   */
  let {
    folders,
    cwd = $bindable(),
    onThisPc,
    api,
    machineName,
    home,
    blocked,
    onPick,
  }: {
    folders: { path: string; label: string }[];
    cwd: string;
    onThisPc: boolean;
    /** The chosen machine's projects methods (its folder browser). */
    api: ProjectsApi;
    machineName: string;
    /** The machine's home folder, where the browser starts without a selected folder. */
    home: string | null;
    /** Why Browse… can't be used on this machine (an older service), else null. */
    blocked: string | null;
    /** A folder chosen with Browse…: the dialog adds it to the list and selects it. */
    onPick: (path: string) => void;
  } = $props();

  let browsing = $state(false);

  const browse = async (): Promise<void> => {
    if (!onThisPc) {
      browsing = true;
      return;
    }
    const path = await pickFolder();
    if (path) onPick(path);
  };

  const selectClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
  <label for="new-chat-folder" class="text-muted-foreground">Folder</label>
  <div class="flex min-w-0 gap-1.5">
    <select id="new-chat-folder" class={selectClass} bind:value={cwd}>
      {#if folders.length === 0}
        <option value="">No projects yet: choose a folder</option>
      {/if}
      {#each folders as f (f.path)}
        <option value={f.path} title={f.path}>{f.label}</option>
      {/each}
    </select>
    <button
      type="button"
      class="hover:bg-muted flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 disabled:opacity-50"
      disabled={!!blocked || (onThisPc && !isTauri)}
      title={blocked ??
        (onThisPc && !isTauri ? 'The folder picker needs the desktop app' : 'Choose any folder')}
      onclick={() => void browse()}
    >
      <FolderOpenIcon class="size-4" aria-hidden="true" /> Browse…
    </button>
  </div>
</div>

{#if cwd}
  <p class="text-muted-foreground -mt-1 truncate font-mono text-[0.6875rem]" title={cwd}>
    {cwd}
  </p>
{/if}

{#if browsing}
  <FolderBrowser
    {api}
    {machineName}
    start={cwd || home || '~'}
    onPick={(path) => {
      browsing = false;
      onPick(path);
    }}
    onCancel={() => (browsing = false)}
  />
{/if}

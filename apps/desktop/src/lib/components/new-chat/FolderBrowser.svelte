<script lang="ts">
  import type { FolderListing } from '@threadgarden/protocol';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import type { ProjectsApi } from '#lib/projects.js';

  /**
   * A dialog for choosing a folder on a machine. Every path comes from the
   * service (`path`, `parent`, each entry's `path`); the client never builds one.
   * Crumbs cover the folders visited on the way down, since the service names
   * only the parent: going to a folder outside that chain starts a new one.
   */
  let {
    api,
    machineName,
    start,
    onPick,
    onCancel,
  }: {
    api: ProjectsApi;
    machineName: string;
    start: string;
    onPick: (path: string) => void;
    onCancel: () => void;
  } = $props();

  let listing = $state<FolderListing | null>(null);
  let chain = $state<string[]>([]);
  let pathText = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let naming = $state(false);
  let newName = $state('');

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // Display only: the last segment of a path the service gave us.
  const label = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  // Only the newest load may show its result; a slower, older one is dropped.
  let seq = 0;

  const load = async (path: string): Promise<void> => {
    const mine = ++seq;
    busy = true;
    error = null;
    try {
      const next = await api.list(path);
      if (mine !== seq) return;
      const at = chain.indexOf(next.path);
      const parentAt = next.parent === null ? -1 : chain.indexOf(next.parent);
      if (at >= 0) chain = chain.slice(0, at + 1);
      else if (parentAt >= 0) chain = [...chain.slice(0, parentAt + 1), next.path];
      else chain = [next.path];
      listing = next;
      pathText = next.path;
    } catch (e) {
      if (mine === seq) error = message(e);
    } finally {
      if (mine === seq) busy = false;
    }
  };

  /** The longest prefix the matches share, ignoring case (the machine may), cased as the first match. */
  const commonPrefix = (items: string[]): string => {
    const first = items[0]!;
    let n = first.length;
    for (const item of items) {
      let i = 0;
      while (i < n && i < item.length && first[i]!.toLowerCase() === item[i]!.toLowerCase()) i++;
      n = i;
    }
    return first.slice(0, n);
  };

  /** The text a completion found nothing more for; Tab then moves on. */
  let stuckAt: string | null = null;

  const complete = async (): Promise<void> => {
    const typed = pathText;
    try {
      const matches = await api.complete(typed);
      if (pathText !== typed) return;
      const found =
        matches.length === 1 ? matches[0]! : matches.length > 1 ? commonPrefix(matches) : typed;
      if (found.length > typed.length || (matches.length === 1 && found !== typed)) {
        pathText = found;
        stuckAt = null;
      } else stuckAt = typed;
      error = null;
    } catch (e) {
      if (pathText === typed) error = message(e);
    }
  };

  const onPathKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pathText) void load(pathText);
    } else if (e.key === 'Tab' && !e.shiftKey && pathText && pathText !== stuckAt) {
      e.preventDefault();
      void complete();
    }
  };

  const makeFolder = async (): Promise<void> => {
    if (!listing || !newName) return;
    busy = true;
    let path: string;
    try {
      path = await api.makeFolder(listing.path, newName);
    } catch (e) {
      error = message(e);
      busy = false;
      return;
    }
    naming = false;
    newName = '';
    await load(path);
  };

  $effect(() => {
    void load(start);
  });
</script>

<Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
  <Dialog.Content class="gap-3 p-5 sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="text-base">Choose a folder on {machineName}</Dialog.Title>
    </Dialog.Header>

    <div class="grid gap-1">
      <label for="folder-browser-path" class="text-muted-foreground text-xs">Path</label>
      <input
        id="folder-browser-path"
        class="bg-background h-8 w-full min-w-0 rounded-md border px-2 font-mono text-sm"
        spellcheck="false"
        autocomplete="off"
        bind:value={pathText}
        onkeydown={onPathKey}
      />
    </div>

    {#if chain.length > 0}
      <nav aria-label="Breadcrumb" class="text-muted-foreground flex flex-wrap gap-1 text-xs">
        {#each chain as crumb, i (crumb)}
          {#if i > 0}<span aria-hidden="true">/</span>{/if}
          <button
            type="button"
            class="hover:text-foreground underline-offset-2 hover:underline"
            onclick={() => void load(crumb)}>{label(crumb)}</button
          >
        {/each}
      </nav>
    {/if}

    <ul class="max-h-64 overflow-y-auto rounded-md border text-sm" aria-busy={busy}>
      {#if listing && listing.parent !== null}
        {@const parent = listing.parent}
        <li>
          <button
            type="button"
            class="hover:bg-muted flex w-full items-center gap-2 px-2 py-1 text-left"
            onclick={() => void load(parent)}>..</button
          >
        </li>
      {/if}
      {#each listing?.folders ?? [] as folder (folder.path)}
        <li>
          <button
            type="button"
            class="hover:bg-muted flex w-full items-center gap-2 px-2 py-1 text-left"
            onclick={() => void load(folder.path)}
          >
            <FolderIcon class="size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{folder.name}</span>
            {#if folder.git}
              <span class="text-muted-foreground text-xs" data-testid="git-mark">git</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>

    {#if naming}
      <form
        class="flex gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          void makeFolder();
        }}
      >
        <input
          aria-label="Folder name"
          class="bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm"
          spellcheck="false"
          autocomplete="off"
          bind:value={newName}
        />
        <button
          type="submit"
          class="hover:bg-muted h-8 shrink-0 rounded-md border px-3 text-sm"
          disabled={busy || !newName}>Create</button
        >
      </form>
    {/if}

    {#if error}
      <p class="text-destructive text-sm" role="alert">{error}</p>
    {/if}

    <Dialog.Footer class="sm:justify-between">
      <button
        type="button"
        class="hover:bg-muted h-8 rounded-md border px-3 text-sm"
        disabled={!listing}
        onclick={() => (naming = !naming)}>New folder</button
      >
      <div class="flex gap-2">
        <button
          type="button"
          class="hover:bg-muted h-8 rounded-md border px-3 text-sm"
          onclick={onCancel}>Cancel</button
        >
        <button
          type="button"
          class="bg-primary text-primary-foreground h-8 rounded-md px-3 text-sm disabled:opacity-50"
          disabled={!listing}
          onclick={() => listing && onPick(listing.path)}>Use this folder</button
        >
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

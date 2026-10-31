<script lang="ts">
  import FileIcon from '@lucide/svelte/icons/file';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import type { FileSuggestion } from '#lib/state/interaction.svelte.js';
  import { splitPath } from './input';

  /**
   * The `@` file picker (spec §6.4): files and folders of the chat's project
   * as a listbox. The composer keeps focus and drives it from the keyboard
   * (`aria-activedescendant`); a click picks with the mouse.
   */
  let {
    id,
    items,
    active,
    loading = false,
    onPick,
    onHover,
  }: {
    id: string;
    items: readonly FileSuggestion[];
    active: number;
    loading?: boolean;
    onPick: (i: number) => void;
    onHover: (i: number) => void;
  } = $props();

  /** Option ids the composer names in `aria-activedescendant`. */
  const optionId = (i: number): string => `${id}-opt-${i}`;
</script>

<ul {id} role="listbox" aria-label="Files" class="max-h-64 overflow-y-auto py-1 text-xs">
  {#each items as f, i (f.path + f.kind)}
    {@const p = splitPath(f.path)}
    <!-- The composer drives the options from the keyboard (aria-activedescendant). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <li
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      class="flex cursor-pointer items-center gap-2 px-2 py-1 {i === active
        ? 'bg-accent text-accent-foreground'
        : ''}"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onPick(i)}
      onmousemove={() => onHover(i)}
    >
      {#if f.kind === 'dir'}
        <FolderIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      {:else}
        <FileIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      {/if}
      <span class="shrink-0 font-medium">{p.name}{f.kind === 'dir' ? '/' : ''}</span>
      <span class="text-muted-foreground min-w-0 truncate">{p.dir}</span>
    </li>
  {/each}
  {#if items.length === 0}
    <li class="text-muted-foreground px-2 py-1" role="presentation">
      {loading ? 'Searching…' : 'No matching files'}
    </li>
  {/if}
</ul>

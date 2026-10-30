<script lang="ts">
  import type { SlashCommand } from '#lib/state/interaction.svelte.js';

  /**
   * The `/` command menu (spec §6.4): commands from `supportedCommands()` as a
   * listbox, driven from the composer's keyboard like the mention picker.
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
    items: readonly SlashCommand[];
    active: number;
    loading?: boolean;
    onPick: (i: number) => void;
    onHover: (i: number) => void;
  } = $props();

  /** Option ids the composer names in `aria-activedescendant`. */
  const optionId = (i: number): string => `${id}-opt-${i}`;
</script>

<ul {id} role="listbox" aria-label="Commands" class="max-h-64 overflow-y-auto py-1 text-xs">
  {#each items as c, i (c.name)}
    <!-- The composer drives the options from the keyboard (aria-activedescendant). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <li
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      class="flex cursor-pointer items-baseline gap-2 px-2 py-1 {i === active
        ? 'bg-accent text-accent-foreground'
        : ''}"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onPick(i)}
      onmousemove={() => onHover(i)}
    >
      <span class="shrink-0 font-mono font-medium">/{c.name}</span>
      {#if c.argumentHint}
        <span class="text-muted-foreground shrink-0 font-mono">{c.argumentHint}</span>
      {/if}
      <span class="text-muted-foreground min-w-0 truncate">{c.description}</span>
    </li>
  {/each}
  {#if items.length === 0}
    <li class="text-muted-foreground px-2 py-1" role="presentation">
      {loading
        ? 'Loading commands…'
        : 'No matching commands (the list fills in once Claude Code has run in this project)'}
    </li>
  {/if}
</ul>

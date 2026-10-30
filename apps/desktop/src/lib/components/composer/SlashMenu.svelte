<script lang="ts">
  import type { MenuCommand } from './commands';

  /**
   * The `/` command menu (spec §6.4): commands from `supportedCommands()` plus
   * pahub's table of terminal-only ones (ruling R25) as a listbox, driven from
   * the composer's keyboard like the mention picker. Unavailable commands are
   * greyed out with the reason; picking one shows that reason instead.
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
    items: readonly MenuCommand[];
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
      aria-disabled={c.unavailable ? 'true' : undefined}
      title={c.unavailable ? `Unavailable in pahub: ${c.unavailable}` : undefined}
      class="flex cursor-pointer items-baseline gap-2 px-2 py-1 {i === active
        ? 'bg-accent text-accent-foreground'
        : ''} {c.unavailable ? 'opacity-55' : ''}"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onPick(i)}
      onmousemove={() => onHover(i)}
    >
      <span class="shrink-0 font-mono font-medium">/{c.name}</span>
      {#if c.argumentHint}
        <span class="text-muted-foreground shrink-0 font-mono">{c.argumentHint}</span>
      {/if}
      {#if c.unavailable}
        <span class="text-muted-foreground min-w-0 truncate"
          ><span class="font-medium">Unavailable in pahub</span> · {c.unavailable}</span
        >
      {:else}
        <span class="text-muted-foreground min-w-0 truncate">{c.description}</span>
      {/if}
    </li>
  {/each}
  {#if items.length === 0}
    <li class="text-muted-foreground px-2 py-1" role="presentation">
      {loading ? 'Loading commands…' : 'No matching commands'}
    </li>
  {/if}
</ul>

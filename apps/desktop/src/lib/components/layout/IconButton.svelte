<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import ActionTooltip from '#lib/components/ActionTooltip.svelte';
  import { ariaKeyShortcuts, type Combo } from '#lib/shortcuts.js';

  /**
   * Icon-only button: `label` is its accessible name and its tooltip. A
   * `shortcut` (keys as in `shortcuts.ts`) follows the label in the tooltip
   * in a secondary color and is announced through `aria-keyshortcuts`.
   */
  let {
    label,
    onclick,
    children: icon,
    class: className,
    side = 'bottom',
    disabled = false,
    shortcut,
    tabindex,
    onauxclick,
    pressed,
  }: {
    label: string;
    onclick: () => void;
    children: Snippet;
    class?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    shortcut?: Combo;
    tabindex?: number;
    onauxclick?: (e: MouseEvent) => void;
    /** A toggle: announced as pressed or not (`aria-pressed`). */
    pressed?: boolean;
  } = $props();

  const aria = $derived(shortcut ? ariaKeyShortcuts([shortcut]) || undefined : undefined);
</script>

<ActionTooltip {label} combos={shortcut ? [shortcut] : undefined} {side}>
  {#snippet children({ props })}
    <Button
      {...props}
      variant="ghost"
      size="icon-xs"
      class="text-muted-foreground hover:text-foreground {className ?? ''}"
      aria-label={label}
      aria-keyshortcuts={aria}
      aria-pressed={pressed}
      {tabindex}
      {disabled}
      {onclick}
      {onauxclick}
    >
      {@render icon()}
    </Button>
  {/snippet}
</ActionTooltip>

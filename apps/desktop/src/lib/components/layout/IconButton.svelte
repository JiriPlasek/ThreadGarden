<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { ariaKeyShortcuts, formatShortcut, type Combo } from '#lib/shortcuts.js';

  /**
   * Icon-only button: `label` is its accessible name and its tooltip. A
   * `shortcut` (keys as in `shortcuts.ts`) follows the label in the tooltip
   * ("New chat · Ctrl+N") and is announced through `aria-keyshortcuts`.
   */
  let {
    label,
    onclick,
    children,
    class: className,
    side = 'bottom',
    disabled = false,
    shortcut,
    tabindex,
    onauxclick,
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
  } = $props();

  const keys = $derived(shortcut ? formatShortcut(shortcut) : null);
  const aria = $derived(shortcut ? ariaKeyShortcuts([shortcut]) || undefined : undefined);
</script>

<Tooltip.Provider delayDuration={400}>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-foreground {className ?? ''}"
          aria-label={label}
          aria-keyshortcuts={aria}
          {tabindex}
          {disabled}
          {onclick}
          {onauxclick}
        >
          {@render children()}
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content {side} class="px-2 py-1">{keys ? `${label} · ${keys}` : label}</Tooltip.Content
    >
  </Tooltip.Root>
</Tooltip.Provider>

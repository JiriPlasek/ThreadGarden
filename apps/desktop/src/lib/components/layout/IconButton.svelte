<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';

  /** Icon-only button: `label` is its accessible name and its tooltip. */
  let {
    label,
    onclick,
    children,
    class: className,
    side = 'bottom',
  }: {
    label: string;
    onclick: () => void;
    children: Snippet;
    class?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
  } = $props();
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
          {onclick}
        >
          {@render children()}
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content {side} class="px-2 py-1">{label}</Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>

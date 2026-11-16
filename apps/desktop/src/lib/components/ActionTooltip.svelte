<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import type { Combo } from '#lib/shortcuts.js';
  import ShortcutHint from './ShortcutHint.svelte';

  let {
    label,
    combos,
    side = 'bottom',
    children,
  }: {
    label: string;
    combos?: readonly Combo[];
    side?: 'top' | 'bottom' | 'left' | 'right';
    children: NonNullable<ComponentProps<typeof Tooltip.Trigger>['child']>;
  } = $props();
</script>

<Tooltip.Provider delayDuration={400}>
  <Tooltip.Root>
    <Tooltip.Trigger child={children} />
    <Tooltip.Content {side} class="gap-3 px-2 py-1">
      {label}
      {#if combos}
        <ShortcutHint {combos} class="text-background/65 pl-0" />
      {/if}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>

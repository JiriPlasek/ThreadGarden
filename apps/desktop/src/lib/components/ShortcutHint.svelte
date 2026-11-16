<script lang="ts">
  import { formatCombos, type Combo } from '#lib/shortcuts.js';
  import { cn } from '#lib/utils.js';

  let {
    combos,
    scopeLabel,
    class: className,
  }: {
    combos: readonly Combo[];
    scopeLabel?: string;
    class?: string;
  } = $props();
</script>

<span
  data-shortcut-hint
  aria-hidden="true"
  class={cn(
    'text-muted-foreground ml-auto shrink-0 pl-4 font-sans text-xs tracking-normal whitespace-nowrap',
    className,
  )}>{formatCombos(combos).join(' or ')}{scopeLabel ? ` (${scopeLabel})` : ''}</span
>

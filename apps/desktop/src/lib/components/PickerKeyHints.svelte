<script lang="ts">
  import { shortcut } from '#lib/shortcuts.js';
  import ShortcutHint from './ShortcutHint.svelte';

  let { switcher = false }: { switcher?: boolean } = $props();
</script>

<div
  aria-hidden="true"
  class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs"
>
  <span class="flex items-center gap-1.5"
    ><ShortcutHint
      combos={shortcut(switcher ? 'switcher-move' : 'picker-move').combos}
      class="ml-0 pl-0"
    /> move</span
  >
  <span class="flex items-center gap-1.5"
    ><ShortcutHint
      combos={shortcut(switcher ? 'switcher-choose' : 'picker-pick').combos}
      class="ml-0 pl-0"
    />
    {switcher ? 'open' : 'insert'}</span
  >
  <span class="ml-auto flex items-center gap-1.5"
    ><ShortcutHint combos={shortcut('picker-close').combos} class="ml-0 pl-0" /> close</span
  >
</div>

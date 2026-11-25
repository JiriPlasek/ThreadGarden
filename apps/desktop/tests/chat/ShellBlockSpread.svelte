<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import ShellBlock from '../../src/lib/components/chat/items/ShellBlock.svelte';

  /** The block as MessageList draws it: every prop spread from one object. */
  let { block }: { block: ComponentProps<typeof ShellBlock> } = $props();
</script>

<ShellBlock {...block} />

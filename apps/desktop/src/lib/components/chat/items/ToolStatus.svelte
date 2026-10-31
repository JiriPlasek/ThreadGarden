<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import XIcon from '@lucide/svelte/icons/x';

  /** Running / done / failed glyph for tool rows. */
  let { status }: { status: 'running' | 'ok' | 'error' } = $props();
</script>

{#if status === 'running'}
  <LoaderCircleIcon
    class="text-muted-foreground size-4 shrink-0 animate-spin"
    aria-label="Running"
  />
{:else if status === 'error'}
  <XIcon class="text-destructive size-4 shrink-0" aria-label="Failed" />
{:else}
  <CheckIcon class="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Done" />
{/if}

<script lang="ts">
  import type { ChatTask } from '@threadgarden/protocol';

  /** The background tasks ending a chat stops (End session, end and archive). */
  let { tasks }: { tasks: readonly ChatTask[] } = $props();

  /** Shown at most; the rest is counted. */
  const MAX_LISTED = 6;
</script>

{#if tasks.length > 0}
  <ul class="text-muted-foreground max-h-40 list-disc overflow-auto pl-5 text-sm">
    {#each tasks.slice(0, MAX_LISTED) as t (t.taskId)}
      <li class="truncate" title={t.description}>{t.description}</li>
    {/each}
  </ul>
  {#if tasks.length > MAX_LISTED}
    <p class="text-muted-foreground text-sm">and {tasks.length - MAX_LISTED} more</p>
  {/if}
{/if}

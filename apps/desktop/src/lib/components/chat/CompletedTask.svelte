<script lang="ts">
  import type { CompletedTaskSummary } from './concise';
  import TaskStatusIcon from './TaskStatusIcon.svelte';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { elapsed, tokens } from './format';
  let { task }: { task: CompletedTaskSummary } = $props();
</script>

<details data-concise-task class="group rounded-md border text-xs">
  <summary
    class="hover:bg-muted/60 flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 [&::-webkit-details-marker]:hidden"
  >
    <ChevronRightIcon
      class="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-90"
      aria-hidden="true"
    />
    <TaskStatusIcon {task} />
    <span class="min-w-0 truncate font-medium">{task.description}</span>
    <span class="text-muted-foreground shrink-0">
      {task.status === 'unknown'
        ? 'Finished, outcome unknown'
        : task.status === 'completed'
          ? 'Completed'
          : task.status === 'failed'
            ? 'Failed'
            : 'Stopped'}
      {#if task.durationMs !== undefined}
        · {elapsed(task.durationMs)}{/if}
      {#if task.tokens !== undefined}
        · {tokens(task.tokens)} tokens{/if}
      {#if task.model}
        · {task.model}{/if}
    </span>
  </summary>
  {#if task.summary && task.summary !== task.description}
    <div class="border-t px-2 py-1 break-words whitespace-pre-wrap">{task.summary}</div>
  {/if}
</details>

<script lang="ts">
  import type { CompletedTaskSummary } from './concise';
  import TaskStatusIcon from './TaskStatusIcon.svelte';
  import { elapsed, tokens } from './format';
  let { task }: { task: CompletedTaskSummary } = $props();
</script>

<div data-concise-task class="rounded-md border bg-muted/30 px-3 py-2 text-sm">
  <div class="flex items-start gap-2">
    <span class="mt-0.5 shrink-0"><TaskStatusIcon {task} /></span>
    <div class="min-w-0 flex-1">
      <div class="font-medium break-words">{task.description}</div>
      <div class="text-muted-foreground text-xs">
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
      </div>
    </div>
  </div>
  {#if task.summary && task.summary !== task.description}
    <div class="mt-1.5 break-words whitespace-pre-wrap">{task.summary}</div>
  {/if}
</div>

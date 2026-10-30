<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleDotIcon from '@lucide/svelte/icons/circle-dot';

  /** The TodoWrite list as a checklist (spec §6.4). Unknown statuses show their raw value. */
  let { item }: { item: Extract<ChatItem, { kind: 'todo' }> } = $props();

  const done = $derived(item.todos.filter((t) => t.status === 'completed').length);
</script>

<div class="rounded-md border px-3 py-2 text-sm">
  <div class="text-muted-foreground mb-1 text-xs font-medium">
    Todos · {done}/{item.todos.length} done
  </div>
  <ul class="flex flex-col gap-0.5" aria-label="Todos">
    {#each item.todos as todo, i (i)}
      <li class="flex items-start gap-2">
        {#if todo.status === 'completed'}
          <CircleCheckIcon
            class="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-label="Done"
          />
          <span class="text-muted-foreground line-through">{todo.content}</span>
        {:else if todo.status === 'in_progress'}
          <CircleDotIcon
            class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-label="In progress"
          />
          <span class="font-medium">{todo.content}</span>
        {:else}
          <CircleIcon
            class="text-muted-foreground mt-0.5 size-3.5 shrink-0"
            aria-label={todo.status === 'pending' ? 'Pending' : todo.status}
          />
          <span
            >{todo.content}
            {#if todo.status !== 'pending'}
              <span class="text-muted-foreground font-mono text-xs">({todo.status})</span>
            {/if}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
</div>

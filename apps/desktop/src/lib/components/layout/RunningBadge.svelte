<script lang="ts">
  import { cn } from '#lib/utils.js';

  /** The "N running" pill of a chat whose agents or background processes are running (spec v1.1 §2). */
  let { count, class: className }: { count: number; class?: string } = $props();
</script>

<span
  class={cn(
    'shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[0.625rem] leading-4 font-medium whitespace-nowrap text-emerald-800 tabular-nums dark:text-emerald-300',
    className,
  )}
  title="{count} {count === 1 ? 'agent or process' : 'agents or processes'} running"
  >{count} running</span
>

<script lang="ts" module>
  import type { ChatTask } from '@pahub/protocol';

  const LABELS: Record<string, string> = {
    pending: 'Pending',
    running: 'Running',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
  };

  /** Accessible label of a task's status; unknown values carry the SDK's own text. */
  export const taskStatusLabel = (t: Pick<ChatTask, 'status' | 'rawStatus'>): string =>
    Object.hasOwn(LABELS, t.status)
      ? LABELS[t.status]!
      : `Unknown status: ${t.rawStatus || t.status}`;
</script>

<script lang="ts">
  import { cn } from '#lib/utils.js';

  /** The status of one Activity panel task, as a small icon with its label as tooltip. */
  let { task, id }: { task: Pick<ChatTask, 'status' | 'rawStatus'>; id?: string } = $props();

  const kind = $derived(Object.hasOwn(LABELS, task.status) ? task.status : 'unknown');
  const label = $derived(taskStatusLabel(task));
</script>

<span
  {id}
  role="img"
  aria-label={label}
  title={label}
  data-status={kind}
  class={cn(
    'inline-flex size-3.5 shrink-0 items-center justify-center',
    kind === 'running' && 'text-emerald-600 dark:text-emerald-400',
    kind === 'completed' && 'text-emerald-600 dark:text-emerald-400',
    kind === 'failed' && 'text-destructive',
    (kind === 'pending' || kind === 'paused' || kind === 'stopped' || kind === 'unknown') &&
      'text-muted-foreground',
  )}
>
  <svg viewBox="0 0 12 12" class="size-3.5" aria-hidden="true">
    {#if kind === 'running'}
      <circle class="pulse" cx="6" cy="6" r="4.5" fill="currentColor" />
    {:else if kind === 'pending'}
      <circle
        cx="6"
        cy="6"
        r="4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="2.1 1.6"
      />
    {:else if kind === 'paused'}
      <path d="M4 2.5 V9.5 M8 2.5 V9.5" stroke="currentColor" stroke-width="1.75" />
    {:else if kind === 'completed'}
      <path
        d="M2.25 6.25 L5 9 L9.75 3.25"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if kind === 'failed'}
      <path
        d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
      />
    {:else if kind === 'stopped'}
      <rect x="2.75" y="2.75" width="6.5" height="6.5" rx="1" fill="currentColor" />
    {:else}
      <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" stroke-width="1.25" />
      <text x="6" y="8.4" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor"
        >?</text
      >
    {/if}
  </svg>
</span>

<style>
  .pulse {
    animation: task-pulse 1.6s ease-in-out infinite;
  }
  @keyframes task-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>

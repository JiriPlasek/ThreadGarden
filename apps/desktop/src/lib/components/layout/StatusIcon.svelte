<script lang="ts" module>
  import type { ChatStatus } from '@pahub/protocol';

  type Known = Exclude<ChatStatus, 'unknown' | 'history'>;

  const LABELS: Record<Known, string> = {
    needsYou: 'Needs you',
    working: 'Working',
    idle: 'Idle',
    paused: 'Paused (the next message resumes it)',
    failed: 'Failed or interrupted',
  };

  const isKnown = (s: string): s is Known => Object.hasOwn(LABELS, s);

  /**
   * "Your turn" (v1.1 §3): a turn finished while the user was not looking. A chat
   * that waits for an answer or works shows that instead.
   */
  export const isYourTurn = (status: string, unread?: boolean): boolean =>
    !!unread && status !== 'needsYou' && status !== 'working';

  /** Accessible label for a status; unknown values carry their raw text (spec §6.2). */
  export const statusLabel = (status: string, raw?: string, unread?: boolean): string =>
    isYourTurn(status, unread)
      ? 'Your turn'
      : status === 'history'
        ? 'History'
        : isKnown(status)
          ? LABELS[status]
          : `Unknown status: ${raw || status}`;
</script>

<script lang="ts">
  import { cn } from '#lib/utils.js';

  let {
    status,
    raw,
    unread = false,
    decorative = false,
    class: className,
  }: {
    /** A `ChatStatus`, or any value a newer service may send. */
    status: string;
    /** The source's own value (e.g. an external session's state), shown for unknown statuses. */
    raw?: string;
    /** The chat finished a turn the user has not seen (`ChatSummary.unread`). */
    unread?: boolean;
    /** Next to text that already says the same thing: hidden from assistive technology. */
    decorative?: boolean;
    class?: string;
  } = $props();

  const kind = $derived(
    isYourTurn(status, unread)
      ? 'yourTurn'
      : status === 'history'
        ? 'history'
        : isKnown(status)
          ? status
          : 'unknown',
  );
  const label = $derived(statusLabel(status, raw, unread));
</script>

{#if kind === 'history'}
  <span
    class={cn('inline-block size-3.5 shrink-0', className)}
    data-status="history"
    aria-hidden="true"
  ></span>
{:else}
  <span
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : label}
    aria-hidden={decorative ? 'true' : undefined}
    title={decorative ? undefined : label}
    data-status={kind}
    class={cn(
      'inline-flex size-3.5 shrink-0 items-center justify-center',
      kind === 'needsYou' && 'text-amber-500 dark:text-amber-400',
      kind === 'working' && 'text-emerald-500 dark:text-emerald-400',
      kind === 'yourTurn' && 'text-blue-500 dark:text-blue-400',
      (kind === 'idle' || kind === 'paused' || kind === 'unknown') && 'text-muted-foreground',
      kind === 'idle' && 'opacity-70',
      kind === 'failed' && 'text-destructive',
      className,
    )}
  >
    <svg viewBox="0 0 12 12" class="size-3.5" aria-hidden="true">
      {#if kind === 'needsYou'}
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />
      {:else if kind === 'yourTurn'}
        <circle cx="6" cy="6" r="3.5" fill="currentColor" />
        <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" stroke-width="0.75" />
      {:else if kind === 'working'}
        <circle class="pulse" cx="6" cy="6" r="4.5" fill="currentColor" />
      {:else if kind === 'idle'}
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5" />
      {:else if kind === 'paused'}
        <circle
          cx="6"
          cy="6"
          r="4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-dasharray="2.1 1.6"
        />
      {:else if kind === 'failed'}
        <path
          d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
        />
      {:else}
        <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" stroke-width="1.25" />
        <text
          x="6"
          y="8.4"
          text-anchor="middle"
          font-size="6.5"
          font-weight="700"
          fill="currentColor">?</text
        >
      {/if}
    </svg>
  </span>
{/if}

<style>
  .pulse {
    animation: status-pulse 1.6s ease-in-out infinite;
  }
  @keyframes status-pulse {
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

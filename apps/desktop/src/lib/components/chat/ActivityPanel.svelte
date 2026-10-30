<script lang="ts">
  import type { ChatTask } from '@pahub/protocol';
  import XIcon from '@lucide/svelte/icons/x';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import IconButton from '#lib/components/layout/IconButton.svelte';
  import { taskEnded, type ChatState } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import { elapsed, tokens } from './format';
  import TaskStatusIcon from './TaskStatusIcon.svelte';

  /**
   * The Activity panel beside a chat pahub runs (spec v1.1 §2): its subagents
   * (Agents) and background shells, monitors and other tasks (Processes), from
   * the service's task list. Elapsed times tick once a second while the panel
   * is shown and a task has not ended. A process can be stopped (after a
   * confirmation); clicking an agent shows the call that started it.
   */
  let {
    chat,
    overlay = false,
    element = $bindable(null),
    onClose,
    onShowAgent,
  }: {
    chat: ChatState;
    /** A drawer over the chat (narrow panes) rather than a column beside it; Esc closes it. */
    overlay?: boolean;
    /** The panel's root element. */
    element?: HTMLElement | null;
    onClose: () => void;
    /** Scrolls the messages to the tool call with this `toolUseId`, when it is loaded. */
    onShowAgent: (toolUseId: string) => void;
  } = $props();

  const { chats } = useApp();

  const tasks = $derived(chat.tasks);
  const agents = $derived(tasks.filter((t) => t.kind === 'agent'));
  /** Shells, monitors and task types pahub does not know (shown with their raw type). */
  const processes = $derived(tasks.filter((t) => t.kind !== 'agent'));
  /** Paused tasks keep the time they had when first seen paused, so they do not tick. */
  const ticking = $derived(tasks.some((t) => !taskEnded(t) && t.status !== 'paused'));
  const pausedFor = new Map<string, number>();

  let now = $state(Date.now());
  $effect(() => {
    if (!ticking) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  /** Running time: live while the task runs, final once it ended. */
  const since = (t: ChatTask): string => {
    if (t.endedAt !== undefined) return elapsed(t.endedAt - t.startedAt);
    if (taskEnded(t) && t.durationMs !== undefined) return elapsed(t.durationMs);
    if (t.status === 'paused') {
      let frozen = pausedFor.get(t.taskId);
      if (frozen === undefined) {
        frozen = Date.now() - t.startedAt;
        pausedFor.set(t.taskId, frozen);
      }
      return `${elapsed(frozen)} (paused)`;
    }
    pausedFor.delete(t.taskId);
    return elapsed(now - t.startedAt);
  };
  const detailsId = (t: ChatTask): string => `activity-${chat.sessionId}-${t.taskId}`;

  const typeLabel = (t: ChatTask): string => {
    if (t.kind === 'agent') return t.subagentType || t.taskType || 'agent';
    if (t.kind === 'shell') return t.taskType?.startsWith('monitor') ? 'monitor' : 'shell';
    return t.taskType || 'task';
  };

  const stats = (t: ChatTask): string | null => {
    const parts: string[] = [];
    if (t.toolUses !== undefined)
      parts.push(`${t.toolUses} ${t.toolUses === 1 ? 'tool' : 'tools'}`);
    if (t.tokens !== undefined) parts.push(`${tokens(t.tokens)} tokens`);
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const latest = (t: ChatTask): string | null =>
    t.summary || (t.lastTool ? `Last tool: ${t.lastTool}` : null);

  // ── stopping a process ──────────────────────────────────────────────────

  let stopping = $state<ChatTask | null>(null);
  let confirmStop = $state(false);
  const askStop = (t: ChatTask): void => {
    stopping = t;
    confirmStop = true;
  };
  const stopNow = async (): Promise<void> => {
    if (stopping) await chats.stopTask(chat.sessionId, stopping.taskId);
  };

  const rowClass = (t: ChatTask): string =>
    cn('flex w-full items-start gap-2 px-3 py-1.5 text-left', taskEnded(t) && 'opacity-60');
</script>

{#snippet details(t: ChatTask, extra: string | null)}
  <span class="flex min-w-0 flex-1 flex-col gap-0.5" id={detailsId(t)}>
    <span class="truncate text-xs leading-5 font-medium" title={t.description}>{t.description}</span
    >
    <span class="text-muted-foreground flex min-w-0 gap-1.5 text-[0.6875rem] leading-4">
      <span class="truncate">{typeLabel(t)}</span>
      <span aria-hidden="true">·</span>
      <span class="shrink-0 tabular-nums" title="Running time">{since(t)}</span>
      {#if extra}
        <span aria-hidden="true">·</span>
        <span class="truncate tabular-nums">{extra}</span>
      {/if}
    </span>
    {#if t.status === 'failed' && t.error}
      <span class="text-destructive line-clamp-2 text-[0.6875rem] leading-4" title={t.error}
        >{t.error}</span
      >
    {:else if latest(t)}
      <span class="text-muted-foreground truncate text-[0.6875rem] leading-4" title={latest(t)}
        >{latest(t)}</span
      >
    {/if}
  </span>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  bind:this={element}
  aria-label="Activity"
  data-overlay={overlay || undefined}
  class={cn(
    'flex min-h-0 flex-col border-l',
    overlay
      ? 'bg-background absolute inset-y-0 right-0 z-30 w-[min(18rem,90%)] shadow-lg'
      : 'bg-muted/20 w-[min(18rem,40%)] shrink-0',
  )}
  onkeydown={(e) => {
    if (overlay && e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  }}
>
  <div class="flex h-8 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
    <h2 class="shrink-0 text-xs font-semibold">Activity</h2>
    {#if chat.running > 0}
      <span class="text-muted-foreground min-w-0 truncate text-[0.6875rem] tabular-nums"
        >{chat.running} running</span
      >
    {/if}
    <IconButton label="Hide activity" class="ml-auto shrink-0" side="left" onclick={onClose}>
      <XIcon />
    </IconButton>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if tasks.length === 0}
      <p class="text-muted-foreground px-3 py-4 text-xs">
        {#if chat.ownedLive}
          No agents or background processes yet. Subagents and commands Claude runs in the
          background (a dev server, a watcher) show up here.
        {:else}
          Activity is available for chats running in pahub.
        {/if}
      </p>
    {:else}
      <h3
        class="text-muted-foreground px-3 pt-2 pb-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase"
        id="activity-agents-{chat.sessionId}"
      >
        Agents
      </h3>
      {#if agents.length === 0}
        <p class="text-muted-foreground px-3 pb-1 text-xs">No agents</p>
      {:else}
        <ul aria-labelledby="activity-agents-{chat.sessionId}">
          {#each agents as t (t.taskId)}
            {@const extra = stats(t)}
            <li>
              {#if t.toolUseId}
                {@const toolUseId = t.toolUseId}
                <button
                  type="button"
                  class={cn(rowClass(t), 'hover:bg-accent/60 focus-visible:bg-accent/60')}
                  aria-label="Show {t.description} in the chat"
                  aria-describedby="{detailsId(t)}-status {detailsId(t)}"
                  onclick={() => onShowAgent(toolUseId)}
                >
                  <span class="pt-[0.1875rem]"
                    ><TaskStatusIcon task={t} id="{detailsId(t)}-status" /></span
                  >
                  {@render details(t, extra)}
                </button>
              {:else}
                <div class={rowClass(t)}>
                  <span class="pt-[0.1875rem]"><TaskStatusIcon task={t} /></span>
                  {@render details(t, extra)}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <h3
        class="text-muted-foreground px-3 pt-3 pb-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase"
        id="activity-processes-{chat.sessionId}"
      >
        Processes
      </h3>
      {#if processes.length === 0}
        <p class="text-muted-foreground px-3 pb-1 text-xs">No background processes</p>
      {:else}
        <ul aria-labelledby="activity-processes-{chat.sessionId}">
          {#each processes as t (t.taskId)}
            <li class={rowClass(t)}>
              <span class="pt-[0.1875rem]"><TaskStatusIcon task={t} /></span>
              {@render details(t, null)}
              {#if !taskEnded(t) && chat.ownedLive}
                <button
                  type="button"
                  class="bg-background hover:bg-muted mt-0.5 h-6 shrink-0 rounded border px-2 text-xs"
                  aria-label="Stop {t.description}"
                  title="Stop {t.description}"
                  onclick={() => askStop(t)}>Stop</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>

<ConfirmDialog
  bind:open={confirmStop}
  title="Stop this process?"
  description={stopping
    ? `“${stopping.description}” will be stopped. Claude is told it was stopped; the chat keeps running.`
    : undefined}
  confirmLabel="Stop process"
  destructive
  onConfirm={stopNow}
/>

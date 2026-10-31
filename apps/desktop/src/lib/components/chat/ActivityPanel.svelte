<script lang="ts">
  import type { ChatTask } from '@threadgarden/protocol';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import XIcon from '@lucide/svelte/icons/x';
  import { SvelteSet } from 'svelte/reactivity';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import IconButton from '#lib/components/layout/IconButton.svelte';
  import { fullTime } from '#lib/format/time.js';
  import { taskEnded, type ChatState } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { cn } from '#lib/utils.js';
  import { shortModel, taskRows, type TaskRow } from './activity';
  import { elapsed, tokens } from './format';
  import TaskStatusIcon from './TaskStatusIcon.svelte';

  /**
   * The Activity panel beside a chat Threadgarden runs (spec v1.1 §2, v1.3 §2): its
   * subagents (Agents) and background shells, monitors and other tasks
   * (Processes), from the service's task list. Each section lists what has
   * not ended first, then the ended tasks, latest first; a task launched by
   * another task of the section sits indented under it. Elapsed times tick
   * once a second while the panel is shown and a task has not ended. Every
   * row expands to its details; a process can be stopped (after a
   * confirmation); an agent's description shows the call that started it.
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

  /** A prompt longer than this (or than PROMPT_LINES lines) is clamped behind "Show all". */
  const PROMPT_CHARS = 240;
  const PROMPT_LINES = 4;

  const tasks = $derived(chat.tasks);
  const agents = $derived(taskRows(tasks.filter((t) => t.kind === 'agent')));
  /** Shells, monitors and task types Threadgarden does not know (shown with their raw type). */
  const processes = $derived(taskRows(tasks.filter((t) => t.kind !== 'agent')));
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

  // ── details ─────────────────────────────────────────────────────────────

  /**
   * Expanded rows and fully shown prompts, by session and task id: the panel
   * instance is reused when the view switches chats.
   */
  const expanded = new SvelteSet<string>();
  const promptsShown = new SvelteSet<string>();
  const keyOf = (t: ChatTask): string => `${chat.sessionId}\u0000${t.taskId}`;
  const flip = (set: SvelteSet<string>, key: string): void => {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  };

  const longPrompt = (p: string): boolean =>
    p.length > PROMPT_CHARS || p.split('\n', PROMPT_LINES + 1).length > PROMPT_LINES;

  const clock = (ms: number): string => new Date(ms).toLocaleTimeString();

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

  const sectionHeading =
    'text-muted-foreground px-3 pb-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase';
</script>

{#snippet summary(t: ChatTask, extra: string | null)}
  <span class="flex min-w-0 flex-1 flex-col gap-0.5" id={detailsId(t)}>
    <span class="truncate text-xs leading-5 font-medium" title={t.description} data-task-description
      >{t.description}</span
    >
    <span class="text-muted-foreground flex min-w-0 gap-1.5 text-[0.6875rem] leading-4">
      <span class="truncate">{typeLabel(t)}</span>
      {#if t.model}
        <span aria-hidden="true">·</span>
        <span class="truncate" title="Model: {t.model}">{shortModel(t.model)}</span>
      {/if}
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

{#snippet field(label: string, value: string, wrap: boolean = false, title?: string)}
  <dt class="text-muted-foreground">{label}</dt>
  <dd class={cn('min-w-0', wrap ? 'break-words whitespace-pre-wrap' : 'truncate')} {title}>
    {value}
  </dd>
{/snippet}

{#snippet details(r: TaskRow)}
  {@const t = r.task}
  {@const key = keyOf(t)}
  <dl
    id="{detailsId(t)}-details"
    class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-1 pb-0.5 text-[0.6875rem] leading-4"
  >
    {#if t.prompt}
      {@const clamp = longPrompt(t.prompt) && !promptsShown.has(key)}
      <dt class="text-muted-foreground">Prompt</dt>
      <dd class="min-w-0">
        <span
          class={cn('block break-words whitespace-pre-wrap', clamp && 'line-clamp-4')}
          data-prompt>{t.prompt}</span
        >
        {#if longPrompt(t.prompt)}
          <button
            type="button"
            class="text-primary hover:underline"
            aria-expanded={!clamp}
            onclick={() => flip(promptsShown, key)}>{clamp ? 'Show all' : 'Show less'}</button
          >
        {/if}
      </dd>
    {/if}
    {#if t.kind !== 'agent'}
      {@render field('Command', t.description, true)}
    {/if}
    {@render field('Type', typeLabel(t))}
    {#if t.model}
      {@render field('Model', t.model)}
    {/if}
    {#if t.workflowName}
      {@render field('Workflow', t.workflowName)}
    {/if}
    {#if r.parent}
      {@render field('Started by', r.parent.description)}
    {/if}
    {@render field('Started at', clock(t.startedAt), false, fullTime(t.startedAt))}
    {@render field(taskEnded(t) ? 'Duration' : 'Running for', since(t))}
    {#if t.tokens !== undefined}
      {@render field('Tokens', tokens(t.tokens))}
    {/if}
    {#if t.toolUses !== undefined}
      {@render field('Tool uses', String(t.toolUses))}
    {/if}
    {#if t.lastTool}
      {@render field('Last tool', t.lastTool)}
    {/if}
    {#if t.summary}
      {@render field('Summary', t.summary, true)}
    {/if}
    {#if t.backgrounded !== undefined}
      {@render field('Runs in', t.backgrounded ? 'Background' : 'Foreground')}
    {/if}
    {#if t.error}
      <dt class="text-muted-foreground">Error</dt>
      <dd class="text-destructive min-w-0 break-words whitespace-pre-wrap">{t.error}</dd>
    {/if}
  </dl>
{/snippet}

{#snippet row(r: TaskRow)}
  {@const t = r.task}
  {@const open = expanded.has(keyOf(t))}
  {@const extra = t.kind === 'agent' ? stats(t) : null}
  <li class={cn(taskEnded(t) && 'opacity-60')} data-depth={r.depth || undefined}>
    <div
      class="flex w-full items-start gap-1.5 py-1.5 pr-1.5"
      style:padding-left="{0.75 + r.depth * 0.875}rem"
    >
      <span class="pt-[0.1875rem]"><TaskStatusIcon task={t} id="{detailsId(t)}-status" /></span>
      {#if t.kind === 'agent' && t.toolUseId}
        {@const toolUseId = t.toolUseId}
        <button
          type="button"
          class="hover:bg-accent/60 focus-visible:bg-accent/60 -my-0.5 flex min-w-0 flex-1 rounded px-1 py-0.5 text-left"
          aria-label="Show {t.description} in the chat"
          aria-describedby="{detailsId(t)}-status {detailsId(t)}"
          onclick={() => onShowAgent(toolUseId)}
        >
          {@render summary(t, extra)}
        </button>
      {:else}
        <span class="flex min-w-0 flex-1 px-1">{@render summary(t, extra)}</span>
      {/if}
      {#if t.kind !== 'agent' && !taskEnded(t) && chat.ownedLive}
        <button
          type="button"
          class="bg-background hover:bg-muted mt-0.5 h-6 shrink-0 rounded border px-2 text-xs"
          aria-label="Stop {t.description}"
          title="Stop {t.description}"
          onclick={() => askStop(t)}>Stop</button
        >
      {/if}
      <button
        type="button"
        class="text-muted-foreground hover:bg-muted hover:text-foreground mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded"
        aria-label="Details of {t.description}"
        title="Details"
        aria-expanded={open}
        aria-controls={open ? `${detailsId(t)}-details` : undefined}
        onclick={() => flip(expanded, keyOf(t))}
      >
        <ChevronRightIcon
          class={cn('size-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
      </button>
    </div>
    {#if open}
      <div class="pr-3" style:padding-left="{2.125 + r.depth * 0.875}rem">
        {@render details(r)}
      </div>
    {/if}
  </li>
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
          Activity is available for chats running in Threadgarden.
        {/if}
      </p>
    {:else}
      <h3 class={cn(sectionHeading, 'pt-2')} id="activity-agents-{chat.sessionId}">Agents</h3>
      {#if agents.length === 0}
        <p class="text-muted-foreground px-3 pb-1 text-xs">No agents</p>
      {:else}
        <ul aria-labelledby="activity-agents-{chat.sessionId}">
          {#each agents as r (r.task.taskId)}
            {@render row(r)}
          {/each}
        </ul>
      {/if}

      <h3 class={cn(sectionHeading, 'pt-3')} id="activity-processes-{chat.sessionId}">Processes</h3>
      {#if processes.length === 0}
        <p class="text-muted-foreground px-3 pb-1 text-xs">No background processes</p>
      {:else}
        <ul aria-labelledby="activity-processes-{chat.sessionId}">
          {#each processes as r (r.task.taskId)}
            {@render row(r)}
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

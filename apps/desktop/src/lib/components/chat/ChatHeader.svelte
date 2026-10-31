<script lang="ts">
  import ActivityIcon from '@lucide/svelte/icons/activity';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PowerIcon from '@lucide/svelte/icons/power';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
  import { formatHoldUntil } from '#lib/format/hold.js';
  import { fullTime } from '#lib/format/time.js';
  import { baseName, rawStatus } from '#lib/components/layout/chat-info.js';
  import IconButton from '#lib/components/layout/IconButton.svelte';
  import StatusIcon from '#lib/components/layout/StatusIcon.svelte';
  import { copyText } from '#lib/native.js';
  import { shortcut } from '#lib/shortcuts.js';
  import { taskRunning, type ChatState } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { endSessionWarning } from './end-session';
  import { tokens, usd } from './format';
  import RunningTaskList from './RunningTaskList.svelte';

  /**
   * Title row plus the chat's controls (spec §6.4): model, effort and permission
   * mode pickers (chats pahub runs only), context usage, cost, auth, Claude
   * Code version, End session and Copy resume command. A chat running outside
   * pahub gets Stop when Claude Code's background service runs it, and a
   * "stop it there" note when it is open in a terminal. The Activity button
   * shows or hides the Activity panel (Ctrl/Cmd+., handled by ChatView). The
   * "Chat state" menu moves the chat between Active, On hold and Archived; an
   * on-hold chat shows until when and its note (v1.2 §3).
   */
  let {
    chat,
    activityOpen = false,
    onToggleActivity,
  }: {
    chat: ChatState;
    /** The Activity panel is shown. */
    activityOpen?: boolean;
    onToggleActivity?: () => void;
  } = $props();

  const { chats, places, buckets } = useApp();

  /** Ruling R11: pahub never offers bypassPermissions. */
  const PERMISSION_MODES = [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'plan', label: 'Plan' },
    { value: 'auto', label: 'Auto' },
  ];

  const sessionId = $derived(chat.sessionId);
  const header = $derived(chat.header);
  const summary = $derived(chat.summary);
  /** pahub's own process runs this chat: header controls and End session apply. */
  const live = $derived(chat.ownedLive);
  const external = $derived(chat.live ? (summary?.external ?? null) : null);
  /** Run by Claude Code's background service: `claude stop <id>` can stop it. */
  const background = $derived(external?.kind === 'background' && !!external.shortId);
  const project = $derived(
    summary
      ? (places.projects.find((p) => p.projectId === summary.projectId)?.displayName ??
          baseName(summary.cwd))
      : '',
  );

  let modelsRequested = false;
  $effect(() => {
    if (live && chat.models === null && !modelsRequested) {
      modelsRequested = true;
      chats.loadModels(sessionId).catch(() => {
        modelsRequested = false;
      });
    }
  });

  type Option = { value: string; label: string };
  /** The choices, plus the current value when it is not among them (shown as is). */
  const withCurrent = (options: Option[], current: string | undefined): Option[] =>
    current && !options.some((o) => o.value === current)
      ? [{ value: current, label: current }, ...options]
      : options;

  const modelOptions = $derived(
    withCurrent(
      (chat.models ?? []).map((m) => ({ value: m.value, label: m.displayName || m.value })),
      header.model,
    ),
  );
  const effortOptions = $derived(
    withCurrent(
      (chat.models?.find((m) => m.value === header.model)?.supportedEffortLevels ?? []).map(
        (e) => ({ value: e, label: e }),
      ),
      header.effort,
    ),
  );
  const modeOptions = $derived(withCurrent(PERMISSION_MODES, header.permissionMode));

  let error = $state<string | null>(null);

  const change =
    (apply: (sessionId: string, value: string) => Promise<void>, current: () => string) =>
    async (e: Event & { currentTarget: HTMLSelectElement }): Promise<void> => {
      const select = e.currentTarget;
      error = null;
      try {
        await apply(sessionId, select.value);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        select.value = current();
      }
    };

  const usage = $derived.by(() => {
    const u = header.contextUsage;
    if (!u || !(u.max > 0)) return null;
    const pct = Math.min(100, Math.max(0, Math.round((u.used / u.max) * 100)));
    return { pct, text: `${tokens(u.used)} / ${tokens(u.max)} tokens (${pct}%)` };
  });

  let copied = $state(false);
  const copyResume = async (): Promise<void> => {
    error = null;
    try {
      await copyText(await chats.resumeCommand(sessionId));
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  };

  let confirmEnd = $state(false);
  /** Background agents and processes that ending the session stops with the process. */
  const runningTasks = $derived(chat.tasks.filter(taskRunning));
  const busy = $derived(chat.status === 'working' || chat.status === 'needsYou');
  const endDescription = $derived(
    endSessionWarning({ busy, tasks: runningTasks.length, listed: true }) ?? undefined,
  );
  const endNow = async (): Promise<void> => {
    await chats.end(sessionId);
  };
  const end = (): void => {
    if (busy || runningTasks.length > 0) {
      confirmEnd = true;
      return;
    }
    error = null;
    endNow().catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
    });
  };

  let confirmStop = $state(false);
  const stopNow = async (): Promise<void> => {
    await chats.stopExternal(sessionId);
  };

  const bucket = $derived(summary?.bucket ?? 'active');
  /** Ticks once a minute while the chat is on hold ("until today 18:30" reads relative to now). */
  let now = $state(Date.now());
  $effect(() => {
    if (bucket !== 'onHold') return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const moveTo = (to: 'active' | 'onHold' | 'archived'): void => {
    if (!summary) return;
    if (to === 'onHold') buckets.hold([summary]);
    else if (to === 'archived') void buckets.archive([summary]);
    else void buckets.activate([summary]);
  };

  const selectClass =
    'bg-background hover:bg-muted h-6 max-w-40 truncate rounded border px-1 text-xs disabled:cursor-not-allowed disabled:opacity-60';
</script>

<header class="shrink-0 border-b">
  <div class="flex h-10 items-center gap-2 px-4">
    {#if chat.loaded}
      <StatusIcon status={chat.status} raw={rawStatus(summary)} />
    {/if}
    <h1 class="min-w-0 truncate text-sm font-semibold">{summary?.title ?? 'Loading…'}</h1>
    {#if project}
      <span class="text-muted-foreground shrink-0 text-xs">{project}</span>
    {/if}
    {#if bucket === 'onHold'}
      <span
        class="bg-muted text-muted-foreground flex min-w-0 shrink items-center gap-1 rounded px-1.5 text-xs leading-5"
      >
        <PauseIcon class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="shrink-0" title={summary?.holdUntil ? fullTime(summary.holdUntil) : undefined}
          >On hold{summary?.holdUntil !== undefined
            ? ` until ${formatHoldUntil(summary.holdUntil, now)}`
            : ''}</span
        >
        {#if summary?.holdNote}
          <span class="text-foreground/80 min-w-0 truncate" title={summary.holdNote}
            >{summary.holdNote}</span
          >
        {/if}
      </span>
    {:else if bucket === 'archived'}
      <span
        class="bg-muted text-muted-foreground flex shrink-0 items-center gap-1 rounded px-1.5 text-xs leading-5"
      >
        <ArchiveIcon class="size-3.5" aria-hidden="true" />Archived
      </span>
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-0.5">
      {#if summary}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-xs"
                class="text-muted-foreground hover:text-foreground"
                aria-label="Chat state"
                title="Chat state: Active, On hold or Archived"
              >
                <EllipsisIcon />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="min-w-40">
            {#if bucket !== 'active'}
              <DropdownMenu.Item class="py-1 text-xs" onSelect={() => moveTo('active')}>
                <InboxIcon /> Make active
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item class="py-1 text-xs" onSelect={() => moveTo('onHold')}>
              <PauseIcon /> Put on hold…
            </DropdownMenu.Item>
            {#if bucket !== 'archived'}
              <DropdownMenu.Item class="py-1 text-xs" onSelect={() => moveTo('archived')}>
                <ArchiveIcon /> Archive
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
      {#if onToggleActivity}
        <IconButton
          label="Activity panel"
          shortcut={shortcut('activity-toggle').combos[0]}
          pressed={activityOpen}
          class="relative"
          onclick={onToggleActivity}
        >
          <ActivityIcon />
          {#if !activityOpen && chat.running > 0}
            <!-- Running tasks while the panel is hidden: the tab badge says how many. -->
            <span
              class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
              aria-hidden="true"
            ></span>
          {/if}
        </IconButton>
      {/if}
      <IconButton label="Copy resume command" onclick={copyResume}>
        {#if copied}<CheckIcon />{:else}<TerminalIcon />{/if}
      </IconButton>
      {#if external && background}
        <IconButton label="Stop background session" onclick={() => (confirmStop = true)}>
          <CircleStopIcon />
        </IconButton>
      {:else}
        <IconButton label="End session" onclick={end} disabled={!live}>
          <PowerIcon />
        </IconButton>
      {/if}
    </div>
  </div>

  <div
    class="text-muted-foreground flex h-8 items-center gap-2 overflow-hidden px-4 text-xs"
    title={live
      ? undefined
      : external
        ? 'This chat is running outside pahub'
        : 'Settings apply to running chats; send a message to resume this one'}
  >
    {#if external && !background}
      <span class="text-foreground/80 shrink-0">Running in a terminal — stop it there</span>
    {:else if external}
      <span class="text-foreground/80 shrink-0">Running in Claude Code's background service</span>
    {/if}
    <select
      aria-label="Model"
      class={selectClass}
      disabled={!live || modelOptions.length === 0}
      value={header.model ?? ''}
      onchange={change(chats.setModel, () => header.model ?? '')}
    >
      {#if modelOptions.length === 0}
        <option value="">Model</option>
      {/if}
      {#each modelOptions as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
    {#if effortOptions.length > 0}
      <select
        aria-label="Effort"
        class={selectClass}
        disabled={!live}
        value={header.effort ?? ''}
        onchange={change(chats.setEffort, () => header.effort ?? '')}
      >
        {#if !header.effort}
          <option value="">Effort</option>
        {/if}
        {#each effortOptions as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    {/if}
    <select
      aria-label="Permission mode"
      class={selectClass}
      disabled={!live}
      value={header.permissionMode ?? 'default'}
      onchange={change(chats.setPermissionMode, () => header.permissionMode ?? 'default')}
    >
      {#each modeOptions as o (o.value)}
        <option value={o.value} disabled={!PERMISSION_MODES.some((m) => m.value === o.value)}
          >{o.label}</option
        >
      {/each}
    </select>

    {#if error}
      <span class="text-destructive min-w-0 truncate" role="alert" title={error}>{error}</span>
    {/if}

    <div class="ml-auto flex shrink-0 items-center gap-3">
      {#if usage}
        <span class="flex items-center gap-1.5" title="Context: {usage.text}">
          <span
            class="bg-muted relative h-1.5 w-16 overflow-hidden rounded-full"
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usage.pct}
            aria-valuetext={usage.text}
          >
            <span
              class="absolute inset-y-0 left-0 rounded-full {usage.pct >= 80
                ? 'bg-amber-500'
                : 'bg-foreground/50'}"
              style:width="{usage.pct}%"
            ></span>
          </span>
          {usage.pct}%
        </span>
      {/if}
      {#if header.costUsd !== undefined}
        <span title="Session cost">{usd(header.costUsd)}</span>
      {/if}
      {#if header.auth}
        <span
          title={header.auth.kind === 'apiKey'
            ? 'API billing'
            : header.auth.kind === 'subscription'
              ? 'Subscription'
              : 'Authentication'}>{header.auth.label}</span
        >
      {/if}
      {#if header.claudeVersion}
        <span title="Claude Code version">claude {header.claudeVersion}</span>
      {/if}
    </div>
  </div>
</header>

<ConfirmDialog
  bind:open={confirmEnd}
  title="End this session?"
  description={endDescription}
  confirmLabel="End anyway"
  destructive
  onConfirm={endNow}
>
  <RunningTaskList tasks={runningTasks} />
</ConfirmDialog>

<ConfirmDialog
  bind:open={confirmStop}
  title="Stop this background session?"
  description="Claude Code's background service runs this chat. Stopping ends its current work (claude stop); the chat stays in your history and can be resumed."
  confirmLabel="Stop session"
  destructive
  onConfirm={stopNow}
/>

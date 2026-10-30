<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
  import PowerIcon from '@lucide/svelte/icons/power';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import { baseName, rawStatus } from '#lib/components/layout/chat-info.js';
  import IconButton from '#lib/components/layout/IconButton.svelte';
  import StatusIcon from '#lib/components/layout/StatusIcon.svelte';
  import { copyText } from '#lib/native.js';
  import type { ChatState } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { tokens, usd } from './format';

  /**
   * Title row plus the chat's controls (spec §6.4): model, effort and permission
   * mode pickers (chats pahub runs only), context usage, cost, auth, Claude
   * Code version, End session and Copy resume command. A chat running outside
   * pahub gets Stop when Claude Code's background service runs it, and a
   * "stop it there" note when it is open in a terminal.
   */
  let { chat }: { chat: ChatState } = $props();

  const { chats, places } = useApp();

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
  const endNow = async (): Promise<void> => {
    await chats.end(sessionId);
  };
  const end = (): void => {
    if (chat.status === 'working' || chat.status === 'needsYou') {
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
    <div class="ml-auto flex shrink-0 items-center gap-0.5">
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
  description="Claude is still working in this chat. Ending stops the current turn; the chat stays in your history and can be resumed."
  confirmLabel="End anyway"
  destructive
  onConfirm={endNow}
/>

<ConfirmDialog
  bind:open={confirmStop}
  title="Stop this background session?"
  description="Claude Code's background service runs this chat. Stopping ends its current work (claude stop); the chat stays in your history and can be resumed."
  confirmLabel="Stop session"
  destructive
  onConfirm={stopNow}
/>

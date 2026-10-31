<script lang="ts">
  import type { ImageRef, ScheduledSend } from '@pahub/protocol';
  import CheckIcon from '@lucide/svelte/icons/check';
  import GaugeIcon from '@lucide/svelte/icons/gauge';
  import HandIcon from '@lucide/svelte/icons/hand';
  import XIcon from '@lucide/svelte/icons/x';
  import { tick, untrack } from 'svelte';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import Composer from '#lib/components/composer/Composer.svelte';
  import SetupScreen from '#lib/components/SetupScreen.svelte';
  import { clockTime, sendTimeText } from '#lib/format/usage.js';
  import { rowPx } from '#lib/interface-scale.js';
  import { copyText } from '#lib/native.js';
  import { RequestError } from '#lib/service/client.js';
  import type { ResumeCheck } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import type { SendWhen } from '#lib/state/scheduled.svelte.js';
  import ActivityPanel from './ActivityPanel.svelte';
  import ChatHeader from './ChatHeader.svelte';
  import type { RequestActions } from './context';
  import MessageList from './MessageList.svelte';
  import ScheduledSends from './ScheduledSends.svelte';

  /**
   * One open chat: header with controls, the virtualised messages, and the
   * composer. Sending to a chat pahub is not running resumes it, behind the
   * resume-safety check (spec §4.4): blocked → the reason and the terminal
   * command, cannot verify / recently modified → a confirmation, ok → send.
   *
   * Focus: when a new permission request, question or plan arrives in this
   * chat, focus moves to its card — unless the user is typing (the composer
   * has text, or another text field is focused) or focus is elsewhere in the
   * window (e.g. the chat list). The "waiting for you" bar always offers a jump.
   *
   * The Activity panel (spec v1.1 §2) sits on the right. One remembered,
   * global setting decides whether it shows, on every chat (v1.3 §2); the
   * header's Activity button and Ctrl/Cmd+. flip it. In a chat pane narrower
   * than SIDE_PANEL_MIN_REM it would squeeze the messages, so there it is an
   * overlay drawer instead, opened on request in this view only (ruling R30):
   * one that covered the chat on every chat switch would be in the way.
   */
  let { sessionId }: { sessionId: string } = $props();

  const { chats, tabs, interaction, settings, usage, scheduled } = useApp();
  /** A chat just created from the new-chat dialog starts with its composer focused. */
  const focusComposer = untrack(() => interaction.takeComposerFocus(sessionId));
  const chat = $derived(chats.get(sessionId));

  let root = $state<HTMLDivElement | null>(null);
  let composerBox = $state<HTMLTextAreaElement | null>(null);
  let list = $state<ReturnType<typeof MessageList> | null>(null);
  let composer = $state<ReturnType<typeof Composer> | null>(null);

  let forkError = $state<string | null>(null);
  let sendError = $state<string | null>(null);
  let blocked = $state<{ reason: string; command: string | null; copied: boolean } | null>(null);

  const fork = (itemId: string): void => {
    forkError = null;
    chats
      .fork(sessionId, itemId)
      .then((id) => tabs.openTab(id))
      .catch((err: unknown) => {
        forkError = err instanceof Error ? err.message : String(err);
      });
  };

  const requests: RequestActions = {
    respond: (p, answers) => chats.respond(sessionId, p, answers),
    decision: (requestId) => chats.get(sessionId)?.decisions.get(requestId),
  };

  // ── sending and resume safety ───────────────────────────────────────────

  const deliver = async (text: string, images: ImageRef[]): Promise<boolean> => {
    try {
      await chats.send(sessionId, text, images);
      blocked = null;
      return true;
    } catch (err) {
      if (err instanceof RequestError && err.code === 'RESUME_BLOCKED') {
        blocked = { reason: err.message, command: null, copied: false };
      } else {
        sendError = err instanceof Error ? err.message : String(err);
      }
      return false;
    }
  };

  let confirmOpen = $state(false);
  let confirmText = $state('');
  let pendingSend: { text: string; images: ImageRef[] } | null = null;
  let settle: ((sent: boolean) => void) | null = null;

  const describe = (check: ResumeCheck): string => {
    const parts: string[] = [];
    if (check.status === 'unverified') {
      parts.push(
        `pahub can't check whether this chat is open elsewhere${check.reason ? ` (${check.reason})` : ''}.`,
      );
    }
    if (check.recentlyModified) {
      parts.push(
        'Its transcript changed within the last 2 minutes, so it may still be in use in a terminal.',
      );
    }
    parts.push(
      'Continuing a chat in two places at once mixes both into one transcript. Continue here only if it is not open anywhere else.',
    );
    return parts.join(' ');
  };

  /** Resolves once the user confirmed (and the message went out) or cancelled. */
  const askToResume = (check: ResumeCheck, text: string, images: ImageRef[]): Promise<boolean> =>
    new Promise((resolve) => {
      settle?.(false);
      settle = resolve;
      pendingSend = { text, images };
      confirmText = describe(check);
      confirmOpen = true;
    });

  const confirmResume = async (): Promise<void> => {
    const p = pendingSend;
    pendingSend = null;
    const sent = p ? await deliver(p.text, p.images) : false;
    settle?.(sent);
    settle = null;
  };

  $effect(() => {
    if (!confirmOpen && settle) {
      settle(false);
      settle = null;
      pendingSend = null;
    }
  });

  const submit = async (text: string, images: ImageRef[]): Promise<boolean> => {
    sendError = null;
    const c = chats.get(sessionId);
    if (!c) return false;
    if (c.ownedLive) return deliver(text, images);
    let check: ResumeCheck;
    try {
      check = await chats.resumeCheck(sessionId);
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      return false;
    }
    if (check.status === 'blocked') {
      blocked = { reason: check.reason, command: null, copied: false };
      return false;
    }
    blocked = null;
    if (check.status === 'unverified' || check.recentlyModified) {
      return askToResume(check, text, images);
    }
    return deliver(text, images);
  };

  const copyResume = async (): Promise<void> => {
    if (!blocked) return;
    try {
      const command = await chats.resumeCommand(sessionId);
      if (blocked) blocked = { ...blocked, command };
      await copyText(command);
      if (blocked) blocked = { ...blocked, copied: true };
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }
  };

  // ── v1.3 B: usage limit and scheduled sends ─────────────────────────────

  /** A usage limit refused this chat's last turn (until a turn goes through or it resets). */
  const refusal = $derived(usage.refusal(sessionId));
  /** The reset the "When the limit resets" preset uses. */
  const resetAt = $derived(usage.limitResetAt ?? refusal?.resetsAt);

  const schedule = async (text: string, images: ImageRef[], when: SendWhen): Promise<boolean> => {
    sendError = null;
    await scheduled.create(sessionId, text, images, when);
    return true;
  };

  /** The scheduled message open in the composer, and what the composer held before. */
  let editingSend = $state.raw<ScheduledSend | null>(null);
  let beforeEdit: { text: string; images: ImageRef[] } | null = null;

  const startEdit = async (s: ScheduledSend): Promise<void> => {
    sendError = null;
    try {
      const full = await scheduled.get(s.id);
      if (!composer) return;
      beforeEdit ??= composer.current();
      await composer.load(full.text, full.images ?? []);
      editingSend = s;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }
  };

  const stopEdit = (): void => {
    const restore = beforeEdit;
    editingSend = null;
    beforeEdit = null;
    void composer?.load(restore?.text ?? '', restore?.images ?? []);
  };

  const editing = $derived(
    editingSend
      ? {
          label: `Editing the message scheduled for ${sendTimeText(editingSend.sendAt, usage.now)}`,
          onSave: async (text: string, images: ImageRef[]): Promise<boolean> => {
            const id = editingSend?.id;
            if (!id) return false;
            await scheduled.update(id, { text, images });
            const restore = beforeEdit;
            editingSend = null;
            beforeEdit = null;
            // What the box held before the edit comes back.
            if (restore && (restore.text || restore.images.length > 0)) {
              // After the composer has cleared the saved message.
              setTimeout(() => void composer?.load(restore.text, restore.images), 0);
            }
            return true;
          },
          onStop: stopEdit,
        }
      : undefined,
  );

  // A message being edited that went out (or was cancelled elsewhere): the edit ends, its text stays.
  $effect(() => {
    const e = editingSend;
    if (e && !scheduled.forChat(sessionId).some((x) => x.id === e.id)) {
      editingSend = null;
      beforeEdit = null;
    }
  });

  // ── interrupt ───────────────────────────────────────────────────────────

  const working = $derived(chat?.ownedLive === true && chat.status === 'working');

  const interrupt = (): void => {
    chats.interrupt(sessionId).catch((err: unknown) => {
      sendError = err instanceof Error ? err.message : String(err);
    });
  };

  const onkeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.defaultPrevented && working) {
      e.preventDefault();
      interrupt();
    }
  };

  // ── needs-you focus ─────────────────────────────────────────────────────

  const pending = $derived(chat?.pendingRequests ?? []);
  let seen = new Set<string>();
  let primed = false;

  /** Whether moving focus now would interrupt the user. */
  const busyElsewhere = (): boolean => {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    if (!root?.contains(a)) return true;
    if (a === composerBox) return composerBox.value.trim() !== '';
    return (
      a instanceof HTMLInputElement ||
      a instanceof HTMLTextAreaElement ||
      a instanceof HTMLSelectElement ||
      (a instanceof HTMLElement && a.isContentEditable)
    );
  };

  const focusRequest = async (requestId: string, force = false): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await tick();
      const el = root?.querySelector<HTMLElement>(
        `[data-request-id="${CSS.escape(requestId)}"] [data-autofocus]`,
      );
      if (el) {
        if (force || !busyElsewhere()) el.focus();
        return;
      }
      await new Promise((r) => setTimeout(r, 16));
    }
  };

  $effect(() => {
    const ids = pending.map((r) => (r.kind === 'permissionRequest' ? r.requestId : r.id));
    const loaded = chat?.loaded === true;
    untrack(() => {
      if (!loaded) return;
      const fresh = primed ? ids.filter((id) => !seen.has(id)) : [];
      seen = new Set(ids);
      primed = true;
      const last = fresh.at(-1);
      if (last && tabs.active === sessionId && !busyElsewhere()) void focusRequest(last);
    });
  });

  const showRequest = (): void => {
    const first = pending[0];
    list?.scrollToBottom();
    if (first?.kind === 'permissionRequest') void focusRequest(first.requestId, true);
  };

  /**
   * A startup failure that needs a Claude Code update: the setup notice sits
   * above the composer (sending again retries once Claude Code is updated)
   * until dismissed.
   */
  const setupItem = $derived(
    chat?.status === 'failed'
      ? chat.items.findLast((i) => i.kind === 'system' && i.setup === true)
      : undefined,
  );
  let dismissedSetup = $state<string | null>(null);

  // ── Activity panel ──────────────────────────────────────────────────────

  /** Narrower chat panes (≈ 720 px at 100 %) get the panel as an overlay drawer. */
  const SIDE_PANEL_MIN_REM = 42.5;
  /** The chat body's width (0 until measured: then the side column applies). */
  let bodyWidth = $state(0);
  const overlay = $derived(bodyWidth > 0 && bodyWidth < rowPx(SIDE_PANEL_MIN_REM, settings.scale));
  let drawerOpen = $state(false);
  let drawer = $state<HTMLElement | null>(null);

  const activityShown = $derived(
    chat?.loaded === true && (overlay ? drawerOpen : settings.activityOpen),
  );

  const activityToggle = (): HTMLElement | null =>
    root?.querySelector<HTMLElement>('header button[aria-label="Activity panel"]') ?? null;

  const openDrawer = async (): Promise<void> => {
    drawerOpen = true;
    await tick();
    drawer?.querySelector<HTMLElement>('button[aria-label="Hide activity"]')?.focus();
  };

  const closeDrawer = async (): Promise<void> => {
    const a = document.activeElement;
    const inside = !!a && (a === document.body || !!drawer?.contains(a));
    drawerOpen = false;
    await tick();
    if (inside) activityToggle()?.focus();
  };

  const toggleActivity = (): void => {
    if (!chats.get(sessionId)) return;
    if (overlay) void (drawerOpen ? closeDrawer() : openDrawer());
    else settings.setActivityOpen(!settings.activityOpen);
  };

  const onWindowKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
    if (e.defaultPrevented) return;
    if (e.key !== '.' && e.code !== 'Period') return;
    // A modal dialog owns the keyboard while it is open.
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    toggleActivity();
  };

  /** Shows the tool call that started an agent, when it is among the loaded items. */
  const showAgent = (toolUseId: string): void => {
    const item = chat?.items.find((i) => i.kind === 'toolCall' && i.toolUseId === toolUseId);
    if (item) list?.scrollToItem(item.id);
  };

  // ── /model, /effort, /permissions (ruling R25) ──────────────────────────

  const CONTROL_LABELS = {
    model: 'Model',
    effort: 'Effort',
    permissionMode: 'Permission mode',
  } as const;

  /** Focuses (and opens, where the webview allows) the header picker; else says why not. */
  const onControl = (control: keyof typeof CONTROL_LABELS): string | null => {
    const label = CONTROL_LABELS[control];
    const select = root?.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!select) {
      return control === 'effort'
        ? 'This model has no effort levels to choose from.'
        : `The ${label.toLowerCase()} picker is not available yet.`;
    }
    if (select.disabled) {
      return `${label} applies to running chats; send a message to resume this one first.`;
    }
    select.focus();
    try {
      (select as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      // Opening needs a user gesture in some webviews; focus is enough.
    }
    return null;
  };
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- Esc anywhere in the chat stops a working turn; the controls inside handle their own keys. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex min-h-0 flex-1 flex-col" bind:this={root} {onkeydown}>
  {#if chat}
    <ChatHeader {chat} activityOpen={activityShown} onToggleActivity={toggleActivity} />
  {/if}
  {#if forkError}
    <div class="bg-destructive/10 text-destructive shrink-0 px-4 py-1 text-xs" role="alert">
      {forkError}
    </div>
  {/if}
  <div class="relative flex min-h-0 flex-1" data-chat-body bind:clientWidth={bodyWidth}>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if chat?.error && !chat.loaded}
        <div class="flex min-h-0 flex-1 items-center justify-center p-6">
          <p class="text-destructive text-sm" role="alert">
            Could not open this chat: {chat.error}
          </p>
        </div>
      {:else if !chat?.loaded}
        <div class="flex min-h-0 flex-1 items-center justify-center p-6">
          <p class="text-muted-foreground text-sm" role="status">Loading…</p>
        </div>
      {:else}
        {#if chat.error}
          <div class="bg-destructive/10 text-destructive shrink-0 px-4 py-1 text-xs" role="alert">
            {chat.error}
          </div>
        {/if}
        {#if chat.items.length === 0}
          <div
            class="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm"
          >
            No messages yet.
          </div>
        {:else}
          <MessageList
            bind:this={list}
            items={chat.items}
            hasMore={chat.hasMore}
            loadingOlder={chat.loadingOlder}
            onLoadOlder={() => void chats.loadOlder(sessionId)}
            onFork={fork}
            {requests}
            memory={chat.view}
            stickRequests={chat.stickRequests}
          />
        {/if}

        <div class="mx-auto w-full max-w-4xl shrink-0 space-y-1.5 px-4 pt-1 pb-3">
          {#if setupItem && setupItem.kind === 'system' && setupItem.id !== dismissedSetup}
            <SetupScreen
              kind="update"
              problem={setupItem.text}
              compact
              onDismiss={() => (dismissedSetup = setupItem.id)}
            />
          {/if}
          {#if pending.length > 0}
            <div
              class="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-1 text-xs text-amber-900 dark:text-amber-200"
            >
              <HandIcon class="size-4 shrink-0" aria-hidden="true" />
              <span class="flex-1"
                >Claude is waiting for you{pending.length > 1
                  ? ` (${pending.length} requests)`
                  : ''}</span
              >
              <button
                type="button"
                class="font-medium underline-offset-2 hover:underline"
                onclick={showRequest}>Show</button
              >
            </div>
          {/if}
          {#if blocked}
            <div
              class="border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-xs"
              role="alert"
            >
              <div class="flex items-start gap-2">
                <p class="text-destructive min-w-0 flex-1">
                  <span class="font-medium">This chat can't be continued here.</span>
                  {blocked.reason}
                </p>
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Dismiss"
                  onclick={() => (blocked = null)}
                  ><XIcon class="size-4" aria-hidden="true" /></button
                >
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="bg-background hover:bg-muted inline-flex h-6 items-center gap-1 rounded border px-2"
                  onclick={() => void copyResume()}
                >
                  {#if blocked.copied}<CheckIcon class="size-3.5" aria-hidden="true" />{/if}
                  Copy resume command
                </button>
                {#if blocked.command}
                  <code class="bg-muted rounded px-1.5 py-0.5 font-mono">{blocked.command}</code>
                {/if}
              </div>
            </div>
          {/if}
          {#if refusal}
            <div
              class="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-1 text-xs text-red-900 dark:text-red-200"
              role="status"
            >
              <GaugeIcon class="size-4 shrink-0" aria-hidden="true" />
              <span class="flex-1"
                >Usage limit reached{refusal.resetsAt !== undefined
                  ? ` — resets at ${clockTime(refusal.resetsAt)}`
                  : ''}</span
              >
              <button
                type="button"
                class="font-medium underline-offset-2 hover:underline"
                onclick={() => usage.open()}>Usage</button
              >
            </div>
          {/if}
          <ScheduledSends
            {sessionId}
            editingId={editingSend?.id}
            onEdit={(s) => void startEdit(s)}
          />
          {#if sendError}
            <p class="text-destructive text-xs" role="alert">{sendError}</p>
          {/if}
          <Composer
            bind:this={composer}
            bind:textarea={composerBox}
            draftKey={sessionId}
            cwd={chat.summary?.cwd ?? ''}
            commandScope={{ sessionId }}
            {working}
            queued={chat.queuedMessages}
            onSubmit={submit}
            onInterrupt={interrupt}
            {onControl}
            onSchedule={schedule}
            {resetAt}
            limited={refusal !== undefined}
            {editing}
            autofocus={focusComposer}
          />
        </div>
      {/if}
    </div>
    {#if chat && activityShown}
      {#if overlay}
        <!-- Clicking beside the drawer closes it; Esc and its close button do too. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="absolute inset-0 z-20 bg-black/20"
          data-activity-scrim
          aria-hidden="true"
          onclick={() => void closeDrawer()}
        ></div>
      {/if}
      <ActivityPanel
        {chat}
        {overlay}
        bind:element={drawer}
        onClose={toggleActivity}
        onShowAgent={showAgent}
      />
    {/if}
  </div>
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Continue this chat here?"
  description={confirmText}
  confirmLabel="Continue here"
  onConfirm={confirmResume}
/>

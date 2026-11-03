<script lang="ts">
  import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
  import { untrack } from 'svelte';
  import RunningTaskList from '#lib/components/chat/RunningTaskList.svelte';
  import { baseName } from '#lib/components/layout/chat-info.js';
  import FolderBrowser from '#lib/components/new-chat/FolderBrowser.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { leftBehind, MoveChat } from '#lib/move/move-chat.svelte.js';
  import { isTauri, pickFolder } from '#lib/native.js';
  import { projectsApi, supportsMove, supportsProjects } from '#lib/projects.js';
  import { taskRunning } from '#lib/state/chats.svelte.js';
  import { useApp } from '#lib/state/context.js';
  import { machineLabel, machineNameOf, type MachineEntry } from '#lib/state/machines.svelte.js';
  import { chatKey } from '#lib/state/refs.js';

  /**
   * Move to… (move-chat §3): the target machine (every paired machine but the
   * chat's own, This PC included), the folder the chat will use there (with
   * Browse…), and the checks in order: the chat isn't busy, the project on
   * the source is clean, the target is on. A dirty project offers Ask Claude
   * to commit and push, Move anyway and Cancel; a folder that isn't a git
   * repo, Move anyway and Cancel. Then the move (`MoveChat`): Starting
   * ‹target›…, Moving…, and the outcome. While the move runs the dialog stays
   * open; Cancel gives it up until the commit is sent.
   *
   * Stop the chat stops the turn (`chat.interrupt`) for a turn or a prompt;
   * background agents outlive an interrupt, so for them it ends the chat's
   * process (`chat.end`, as End session does).
   */
  const app = useApp();
  const { interaction, machines, scopes, power } = app;

  const ref = $derived(interaction.moveChat.ref);
  /** One `MoveChat` per set of checks: a new target or folder asks again. */
  let move = $state(new MoveChat(app));
  let target = $state('');
  /** A folder chosen with Browse… on the target; else the target's own choice. */
  let picked = $state<string | null>(null);
  let browsing = $state(false);
  /** Why Stop the chat failed. */
  let stopError = $state<string | null>(null);

  type Choice = { id: string; label: string; disabled: boolean; outdated: boolean };

  /** How a machine is offered: one too old or not on (without power control to start it) can't be picked. */
  const choiceOf = (m: MachineEntry): Choice => {
    const name = machineLabel(m);
    const choice = (label: string, disabled: boolean): Choice => ({
      id: m.id,
      label,
      disabled,
      outdated: false,
    });
    if (m.info && !supportsMove(m)) return { ...choice(name, true), outdated: true };
    if (m.status === 'on') return choice(name, false);
    if (power.config(m.id)) {
      const shown = machines.shown(m);
      if (shown === 'off') return choice(`${name} (off, it will be started)`, false);
      if (shown === 'starting') return choice(`${name} (starting)`, false);
      return choice(`${name} (can't be reached)`, true);
    }
    // Without power control, a machine that is not on can't be told apart from one that is off.
    return choice(`${name} (off)`, true);
  };

  const choices = $derived(
    ref ? machines.list.filter((m) => m.id !== ref.machineId).map(choiceOf) : [],
  );
  const outdated = $derived(choices.filter((c) => c.outdated));

  const sourceName = $derived(ref ? machineNameOf(machines, ref.machineId) : '');
  const targetName = $derived(target ? machineNameOf(machines, target) : '');
  const targetEntry = $derived(target ? machines.get(target) : undefined);
  const targetOn = $derived(targetEntry?.status === 'on');
  /** The chat open in a tab, if it is (its title, its background agents). */
  const resident = $derived(ref ? scopes.get(ref.machineId)?.chats.get(ref.sessionId) : undefined);
  const title = $derived(resident?.summary?.title ?? interaction.moveChat.summary?.title ?? null);

  /** Asks the checks again (a new target, folder, or after the chat was stopped). */
  const recheck = (): void => {
    stopError = null;
    move = new MoveChat(app);
    if (ref && target) void move.prepare(ref, target, picked ?? undefined);
  };

  const choose = (id: string): void => {
    target = id;
    picked = null;
    browsing = false;
    recheck();
  };

  let wasOpen = false;
  $effect(() => {
    const open = interaction.moveChat.open;
    if (open && !wasOpen) {
      untrack(() => {
        target = '';
        picked = null;
        browsing = false;
        move = new MoveChat(app);
        const first = choices.find((c) => !c.disabled);
        if (first) choose(first.id);
      });
    }
    wasOpen = open;
  });

  // No machine could take the chat when the dialog opened; the first one that can is chosen.
  $effect(() => {
    if (!interaction.moveChat.open || target) return;
    const first = choices.find((c) => !c.disabled);
    if (first) untrack(() => choose(first.id));
  });

  const phase = $derived(move.state);
  const check = $derived(move.check);
  const git = $derived(check?.source.git ?? null);
  const left = $derived(git ? leftBehind(git) : null);
  const dirty = $derived(git?.kind === 'dirty' && left !== null);
  const notRepo = $derived(git?.kind === 'notRepo');
  const busy = $derived(check?.source.busy ?? null);
  const there = $derived(check?.target ?? null);
  const folder = $derived(picked ?? there?.folder ?? null);
  /** The target's folder is on another branch while chats run there (not for a folder picked instead). */
  const inUse = $derived(
    there?.inUse && (picked === null || picked === there.folder) ? there.inUse : null,
  );
  const inUseText = $derived(
    inUse && there
      ? `${targetName}'s ${baseName(there.folder)} is on ${inUse.branch ?? 'another branch'}; ${inUse.running} ${inUse.running === 1 ? 'chat is' : 'chats are'} running there`
      : null,
  );
  /** The chat's background agents, for "subagents" (known while the chat is open). */
  const tasks = $derived(resident?.tasks.filter(taskRunning) ?? []);
  const busyText = $derived(
    busy === 'turn'
      ? 'Claude is working in this chat. Stop it, or wait until the turn ends and check again.'
      : busy === 'prompt'
        ? 'This chat is waiting for your answer. Answer it or stop the chat, then check again.'
        : busy === 'subagents'
          ? 'Background agents are running in this chat; moving it would cut them off.'
          : busy === 'terminal'
            ? 'This chat is running in a terminal'
            : null,
  );
  /** Threadgarden can stop its own process of the chat, never a terminal's. */
  const canStop = $derived(busy !== null && busy !== 'terminal');

  const inFlight = $derived(phase === 'starting' || phase === 'moving');
  /** The first note didn't send and nothing has sent it since (the chat's own Send again may have). */
  const notePending = $derived(
    phase === 'noting' && ref && target
      ? interaction.pendingNotes[chatKey({ machineId: target, sessionId: ref.sessionId })]
      : undefined,
  );
  const moved = $derived(phase === 'done' || phase === 'noting');
  /** The choices of a checked chat (also after a failed or cancelled move). */
  const choosing = $derived(!!check && (phase === 'ready' || phase === 'failed'));
  /** Anything that will not come along or may get in the way: Move becomes Move anyway. */
  const anyway = $derived(dirty || notRepo || !!inUse);

  // ── Browse… ─────────────────────────────────────────────────────────────

  const onThisPc = $derived(!!targetEntry?.local);
  const canBrowse = $derived(
    targetOn && !!scopes.get(target) && (onThisPc ? isTauri : supportsProjects(targetEntry)),
  );
  const browseApi = $derived(scopes.get(target) ? projectsApi(scopes.get(target)!.api) : null);

  const pick = (path: string): void => {
    browsing = false;
    picked = path;
    recheck();
  };

  const browse = async (): Promise<void> => {
    if (!onThisPc) {
      browsing = true;
      return;
    }
    const path = await pickFolder();
    if (path) pick(path);
  };

  // ── actions ─────────────────────────────────────────────────────────────

  const close = (): void => interaction.closeMoveChat();

  const run = (): void => void move.run({ moveAnyway: anyway });

  const askToPush = async (): Promise<void> => {
    if (!ref) return;
    const asking = move;
    await asking.askToPush(ref);
    if (asking.state === 'idle') close();
  };

  /** Stop the chat, then the checks again: the turn's stop, or End session for background agents. */
  const stopChat = async (): Promise<void> => {
    const r = ref;
    const chats = r ? scopes.get(r.machineId)?.chats : undefined;
    if (!r || !chats) return;
    stopError = null;
    try {
      if (busy === 'subagents') await chats.end(r.sessionId);
      else await chats.interrupt(r.sessionId);
    } catch (e) {
      stopError = e instanceof Error ? e.message : String(e);
      return;
    }
    recheck();
  };

  const selectClass = 'bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm';
</script>

<Dialog.Root
  open={interaction.moveChat.open}
  onOpenChange={(open) => {
    // A running move is given up with Cancel only.
    if (!open && !inFlight) close();
  }}
>
  <Dialog.Content class="gap-4 p-5 sm:max-w-lg" showCloseButton={!inFlight}>
    <Dialog.Header>
      <Dialog.Title class="text-base">Move this chat</Dialog.Title>
      <Dialog.Description class="text-xs">
        {title ? `“${title}” ` : 'The chat '}carries on on the machine you choose, with its whole
        conversation. Its files come from git there.
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
      <label for="move-chat-machine" class="text-muted-foreground">Machine</label>
      <select
        id="move-chat-machine"
        class={selectClass}
        value={target}
        disabled={inFlight || moved}
        onchange={(e) => choose(e.currentTarget.value)}
      >
        {#each choices as c (c.id)}
          <option value={c.id} disabled={c.disabled}>{c.label}</option>
        {/each}
      </select>

      <span class="text-muted-foreground">Folder</span>
      <div class="flex min-w-0 items-center gap-1.5">
        <span
          class="min-w-0 flex-1 truncate font-mono text-[0.6875rem]"
          title={folder ?? undefined}
        >
          {#if folder}{folder}{:else if target && !targetOn}<span
              class="text-muted-foreground font-sans">Chosen once {targetName} is on</span
            >{:else if phase === 'checking'}<span class="text-muted-foreground font-sans"
              >Checking…</span
            >{/if}
        </span>
        <button
          type="button"
          class="hover:bg-muted flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 disabled:opacity-50"
          disabled={!canBrowse || inFlight || moved}
          title={canBrowse
            ? 'Choose another folder'
            : `Browse needs ${targetName || 'the machine'} on`}
          onclick={() => void browse()}
        >
          <FolderOpenIcon class="size-4" aria-hidden="true" /> Browse…
        </button>
      </div>
    </div>

    {#each outdated as c (c.id)}
      <p class="text-muted-foreground text-xs" role="note">
        Update {c.label} to move chats there
      </p>
    {/each}
    {#if ref && choices.length > 0 && choices.every((c) => c.disabled)}
      <p class="text-muted-foreground text-xs">No other machine can take this chat now.</p>
    {/if}

    {#if check && !moved}
      <ul class="grid gap-1.5 text-xs" aria-label="Checks">
        <li>
          {#if busyText}
            <p class="text-amber-800 dark:text-amber-300">{busyText}</p>
            {#if busy === 'subagents'}
              <RunningTaskList {tasks} />
            {/if}
            {#if stopError}
              <p class="text-destructive" role="alert">{stopError}</p>
            {/if}
            <div class="mt-1 flex gap-2">
              {#if canStop}
                <Button size="sm" variant="outline" onclick={() => void stopChat()}
                  >Stop the chat</Button
                >
              {/if}
              <Button size="sm" variant="ghost" onclick={recheck}>Check again</Button>
            </div>
          {:else}
            <p class="text-muted-foreground">The chat isn't busy.</p>
          {/if}
        </li>
        <li>
          {#if git?.kind === 'notRepo'}
            <p class="text-amber-800 dark:text-amber-300">
              <span>This folder isn't a git repo; its files stay on {sourceName}</span>
            </p>
          {:else if dirty}
            <p class="text-amber-800 dark:text-amber-300">
              <span>{left}</span>
            </p>
            <p class="text-muted-foreground">
              Moved anyway, this stays on {sourceName}; Claude is told what is missing.
            </p>
          {:else}
            <p class="text-muted-foreground">
              The project is clean: nothing stays behind on {sourceName}.
            </p>
          {/if}
        </li>
        <li>
          {#if targetOn}
            <p class="text-muted-foreground">{targetName} is on.</p>
          {:else if power.config(target)}
            <p class="text-muted-foreground">{targetName} is off; the move starts it first.</p>
          {:else}
            <p class="text-amber-800 dark:text-amber-300">{targetName} is off</p>
          {/if}
        </li>
        {#if inUseText}
          <li>
            <p class="text-amber-800 dark:text-amber-300"><span>{inUseText}</span></p>
            <p class="text-muted-foreground">
              Pick another folder with Browse…, or move anyway: Claude stops and asks before
              switching branches.
            </p>
          </li>
        {/if}
      </ul>
    {/if}

    <div role="status" class="grid gap-1 text-xs">
      {#if phase === 'starting'}
        <p>Starting {targetName}…</p>
      {:else if phase === 'moving'}
        <p>Moving…</p>
      {:else if moved}
        <p class="font-medium">Moved to {targetName}</p>
      {/if}
    </div>

    {#if notePending}
      <p class="text-destructive text-xs" role="alert">
        Claude's first note on {targetName} didn't send: {notePending.problem}
      </p>
    {:else if move.problem && phase !== 'noting'}
      <p class="text-destructive text-xs" role="alert">{move.problem}</p>
    {/if}
    {#if moved && move.oldCopyShown}
      <p class="text-xs" role="alert">
        <span>The old copy on {sourceName} is still shown</span>
      </p>
    {/if}

    <Dialog.Footer>
      {#if inFlight}
        <!-- Once the commit is sent the move can't be given up: no Cancel. -->
        {#if move.cancellable}
          <Button size="sm" variant="outline" onclick={() => move.abandon()}>Cancel</Button>
        {/if}
      {:else if moved}
        {#if move.oldCopyShown}
          <Button size="sm" variant="outline" onclick={() => void move.retryMarkMoved()}
            >Retry</Button
          >
        {/if}
        {#if notePending}
          <Button size="sm" variant="outline" onclick={() => void move.sendNoteAgain()}
            >Send again</Button
          >
        {/if}
        <Button size="sm" onclick={close}>Close</Button>
      {:else if choosing}
        <!-- In the spec's order: Ask Claude to commit and push · Move anyway · Cancel. -->
        {#if dirty}
          <Button size="sm" onclick={() => void askToPush()}>Ask Claude to commit and push</Button>
        {/if}
        <Button
          size="sm"
          variant={dirty ? 'outline' : 'default'}
          disabled={!!busy || !target}
          onclick={run}>{anyway ? 'Move anyway' : 'Move'}</Button
        >
        <Button size="sm" variant="outline" onclick={close}>Cancel</Button>
      {:else if phase === 'failed'}
        <Button size="sm" variant="outline" onclick={close}>Close</Button>
        <Button size="sm" onclick={recheck}>Check again</Button>
      {:else}
        <Button size="sm" variant="outline" onclick={close}>Cancel</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

{#if browsing && browseApi}
  <FolderBrowser
    api={browseApi}
    machineName={targetName}
    start={folder ?? targetEntry?.info?.home ?? '~'}
    onPick={pick}
    onCancel={() => (browsing = false)}
  />
{/if}

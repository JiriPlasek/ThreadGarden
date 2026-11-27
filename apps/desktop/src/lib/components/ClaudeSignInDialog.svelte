<script lang="ts" module>
  /** How long "Signed in as …" shows before the dialog closes. */
  export const SIGNED_IN_MS = 1500;
</script>

<script lang="ts">
  import { CLAUDE_LOGIN_ERRORS } from '@threadgarden/protocol';
  import { untrack } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { copyText, openExternal } from '#lib/native.js';
  import { RequestError } from '#lib/service/client.js';
  import { quietly } from '#lib/state/api.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * Sign in to Claude on one machine (protocol 14): the machine starts a
   * sign-in and gives a link; the owner approves on claude.ai, anywhere, and
   * pastes the code it shows. A refused code ends that sign-in (Claude Code's
   * own behaviour), so the dialog then offers Start again, a fresh link.
   * However the dialog closes (Cancel, its X, Escape, Back on the phone) a
   * sign-in still open on the machine is cancelled.
   *
   * The link and the code live in this component only: never stored or logged.
   */
  let {
    machineId,
    machineName,
    sessionId,
    open = $bindable(false),
  }: {
    machineId: string;
    machineName: string;
    /** The chat that asked (a chat's sign-in line or `/login`); the machine signs in on a helper process. */
    sessionId?: string;
    open?: boolean;
  } = $props();

  const { claudeAccounts } = useApp();

  type Phase = 'starting' | 'ready' | 'submitting' | 'failed' | 'done';
  let phase = $state<Phase>('starting');
  let url = $state<string | null>(null);
  let code = $state('');
  let error = $state<string | null>(null);
  /** Who it signed in as (null: the machine didn't say). */
  let signedInAs = $state<string | null>(null);
  let copied = $state(false);
  /** The machine has no Claude sign-in (an API key, a provider): starting again can't help. */
  let unsupported = $state(false);

  /** A sign-in may be open on the machine: closing cancels it. */
  let live = false;
  /** Bumped by every start and close: a late answer of an earlier one is dropped. */
  let generation = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const words = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : 'Something went wrong.';

  /** Starts a sign-in (again): a new link, an empty field. */
  const begin = async (): Promise<void> => {
    const mine = ++generation;
    phase = 'starting';
    url = null;
    code = '';
    error = null;
    unsupported = false;
    live = true;
    try {
      const link = await claudeAccounts.signIn(machineId, sessionId);
      if (mine !== generation) {
        // Closed meanwhile: the sign-in that just began is not wanted.
        if (!open) quietly(claudeAccounts.cancel(machineId));
        return;
      }
      url = link;
      phase = 'ready';
    } catch (err) {
      if (mine !== generation) return;
      live = false;
      unsupported = err instanceof RequestError && err.code === CLAUDE_LOGIN_ERRORS.unsupported;
      error = words(err);
      phase = 'failed';
    }
  };

  const end = (): void => {
    generation++;
    clearTimeout(closeTimer);
    clearTimeout(copiedTimer);
    if (live) {
      live = false;
      quietly(claudeAccounts.cancel(machineId));
    }
    phase = 'starting';
    url = null;
    code = '';
    error = null;
    signedInAs = null;
    copied = false;
    unsupported = false;
  };

  let wasOpen = false;
  $effect(() => {
    const now = open;
    untrack(() => {
      if (now && !wasOpen) void begin();
      else if (!now && wasOpen) end();
    });
    wasOpen = now;
  });
  $effect(() => () => {
    if (wasOpen) end();
  });

  const submit = async (): Promise<void> => {
    const pasted = code.trim();
    if (phase !== 'ready' || pasted === '') return;
    const mine = generation;
    phase = 'submitting';
    error = null;
    try {
      const account = await claudeAccounts.submit(machineId, pasted);
      if (mine !== generation) return;
      live = false;
      signedInAs = account?.email ?? null;
      phase = 'done';
      closeTimer = setTimeout(() => (open = false), SIGNED_IN_MS);
    } catch (err) {
      if (mine !== generation) return;
      // A refused code ends the sign-in on the machine; anything else may leave it open.
      const over =
        err instanceof RequestError &&
        (err.code === CLAUDE_LOGIN_ERRORS.failed || err.code === CLAUDE_LOGIN_ERRORS.notStarted);
      if (over) live = false;
      url = null;
      code = '';
      error = words(err);
      phase = 'failed';
    }
  };

  const copy = async (): Promise<void> => {
    if (!url) return;
    await copyText(url);
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  };

  const fieldId = $props.id();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="grid-cols-[minmax(0,1fr)] gap-4 p-5 sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="text-base">Sign in to Claude ({machineName})</Dialog.Title>
      <Dialog.Description class="sr-only"
        >Sign in to Claude Code on {machineName} with your claude.ai account.</Dialog.Description
      >
    </Dialog.Header>

    {#if phase === 'done'}
      <p class="text-sm" role="status">
        {signedInAs ? `Signed in as ${signedInAs}.` : 'Signed in.'}
      </p>
    {:else}
      {#if phase !== 'failed'}
        <ol class="grid list-decimal gap-3 pl-5 text-sm">
          <li class="grid gap-1.5">
            <span>Open this link and approve:</span>
            {#if url}
              <span
                class="bg-muted rounded-md px-2 py-1 font-mono text-xs break-all select-all"
                data-testid="claude-sign-in-link">{url}</span
              >
              <div class="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onclick={() => void copy()}
                  >{copied ? 'Copied' : 'Copy'}</Button
                >
                <Button size="sm" variant="outline" onclick={() => void openExternal(url ?? '')}
                  >Open</Button
                >
              </div>
            {:else}
              <span class="text-muted-foreground text-xs">…</span>
            {/if}
          </li>
          <li class="grid gap-1.5">
            <label for="{fieldId}-code">Paste the code claude.ai shows you</label>
            <input
              id="{fieldId}-code"
              class="bg-background h-8 w-full min-w-0 rounded-md border px-2 font-mono text-sm"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              disabled={phase !== 'ready'}
              bind:value={code}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </li>
        </ol>
      {/if}
      {#if error}
        <p class="text-destructive text-sm break-words" role="alert">{error}</p>
      {/if}
      <Dialog.Footer class="flex-row justify-end gap-2">
        <Button variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
        {#if phase === 'failed'}
          {#if !unsupported}
            <Button size="sm" onclick={() => void begin()}>Start again</Button>
          {/if}
        {:else}
          <Button size="sm" disabled={phase !== 'ready' || code.trim() === ''} onclick={submit}
            >Sign in</Button
          >
        {/if}
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

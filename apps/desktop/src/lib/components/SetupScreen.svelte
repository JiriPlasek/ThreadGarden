<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import { copyText, openExternal } from '#lib/native.js';

  /**
   * Shown when pahub cannot run Claude Code (spec §6.4): it is not installed
   * (or not where pahub looks), or a session refused to start because the
   * installed version is too old. pahub never falls back to a bundled copy;
   * this screen explains how to install or update it.
   */
  let {
    kind,
    problem,
    compact = false,
    checking = false,
    onRetry,
    onDismiss,
  }: {
    kind: 'missing' | 'update';
    problem?: string;
    /** Inline in a chat instead of the whole window. */
    compact?: boolean;
    checking?: boolean;
    onRetry?: () => void;
    onDismiss?: () => void;
  } = $props();

  const DOCS = 'https://code.claude.com/docs/en/setup';
  const windows = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);

  const steps = $derived(
    kind === 'update'
      ? [{ label: 'Update Claude Code', command: 'claude update' }]
      : [
          windows
            ? { label: 'Windows (PowerShell)', command: 'irm https://claude.ai/install.ps1 | iex' }
            : {
                label: 'macOS / Linux',
                command: 'curl -fsSL https://claude.ai/install.sh | bash',
              },
          { label: 'Or with npm', command: 'npm install -g @anthropic-ai/claude-code' },
        ],
  );

  let copied = $state<string | null>(null);
  const copy = (command: string): void => {
    copyText(command)
      .then(() => {
        copied = command;
        setTimeout(() => (copied = null), 1500);
      })
      .catch(() => {});
  };

  const title = $derived(kind === 'update' ? 'Update Claude Code' : 'Set up Claude Code');
</script>

<section
  aria-label={title}
  class={compact
    ? 'rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 text-sm'
    : 'mx-auto flex max-w-lg flex-col gap-4 p-8 text-sm'}
>
  <div class="flex items-center gap-2">
    <TerminalIcon class="size-5 shrink-0 text-amber-600" aria-hidden="true" />
    <h2 class={compact ? 'font-semibold' : 'text-lg font-semibold'}>
      {kind === 'update' ? 'Claude Code needs an update' : 'pahub works with Claude Code'}
    </h2>
  </div>
  <p class="text-muted-foreground mt-2">
    {kind === 'update'
      ? 'This chat could not start because the installed Claude Code is older than the minimum version. Update it, then send your message again.'
      : 'pahub runs your chats with the Claude Code you have installed, and could not find it. Install it, then check again.'}
  </p>
  {#if problem}
    <p class="bg-muted mt-2 rounded px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap">
      {problem}
    </p>
  {/if}

  <ul class="mt-3 space-y-2">
    {#each steps as s (s.command)}
      <li>
        <div class="text-muted-foreground mb-0.5 text-xs">{s.label}</div>
        <div class="bg-muted flex items-center gap-2 rounded-md px-2 py-1">
          <code class="min-w-0 flex-1 truncate font-mono text-xs">{s.command}</code>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Copy {s.command}"
            onclick={() => copy(s.command)}
          >
            {#if copied === s.command}<CheckIcon class="size-4" />{:else}<CopyIcon
                class="size-4"
              />{/if}
          </button>
        </div>
      </li>
    {/each}
  </ul>

  <p class="text-muted-foreground mt-3 text-xs">
    Installed somewhere else? Set the Claude executable path in pahub's settings. More help:
    <a
      href={DOCS}
      class="underline underline-offset-2"
      onclick={(e) => {
        e.preventDefault();
        openExternal(DOCS).catch(() => {});
      }}>Claude Code setup</a
    >.
  </p>

  {#if onRetry || onDismiss}
    <div class="mt-4 flex items-center gap-2">
      {#if onRetry}
        <button
          type="button"
          class="bg-primary text-primary-foreground h-8 rounded-md px-3 text-xs font-medium disabled:opacity-50"
          disabled={checking}
          onclick={onRetry}>{checking ? 'Checking…' : 'Check again'}</button
        >
      {/if}
      {#if onDismiss}
        <button
          type="button"
          class="hover:bg-muted h-8 rounded-md border px-3 text-xs"
          onclick={onDismiss}>{kind === 'update' ? 'Dismiss' : 'Browse history without it'}</button
        >
      {/if}
    </div>
  {/if}
</section>

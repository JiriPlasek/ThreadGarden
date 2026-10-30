<script lang="ts">
  import HandIcon from '@lucide/svelte/icons/hand';
  import { chatActions } from '../context';
  import { editDiffs, prettyJson, str, summarize } from '../tools';
  import DiffView from './DiffView.svelte';
  import RequestSettled from './RequestSettled.svelte';
  import { asToolCall, suggestionLabel, type RequestItem } from './requests';

  /**
   * A tool permission request (spec §6.4 "Controls"): the tool and its input
   * (command for Bash, diff for edits), then Allow, one "Always allow" per rule
   * Claude Code suggests, and Deny with optional feedback. Bypass-mode
   * suggestions never reach the UI (filtered by the service, Ruling R11).
   */
  let { item }: { item: RequestItem } = $props();

  const requests = chatActions().requests;
  /** At most this many "Always allow" choices are offered. */
  const MAX_SUGGESTIONS = 3;

  const call = $derived(asToolCall(item));
  const input = $derived(
    typeof item.input === 'object' && item.input !== null
      ? (item.input as Record<string, unknown>)
      : {},
  );
  const command = $derived(item.toolName === 'Bash' ? str(input.command) : '');
  const diffs = $derived(editDiffs(call));
  const target = $derived(summarize(call, { stats: false }).target);
  const suggestions = $derived(item.suggestions.slice(0, MAX_SUGGESTIONS));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let feedbackOpen = $state(false);
  let feedback = $state('');
  let feedbackInput = $state<HTMLInputElement | null>(null);

  const answer = async (
    decision: 'allow' | 'allowAlways' | 'deny',
    extra: { suggestionIndex?: number; reason?: string } = {},
  ): Promise<void> => {
    if (!requests || busy) return;
    busy = true;
    error = null;
    try {
      await requests.respond({ requestId: item.requestId, decision, ...extra });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };

  const openFeedback = (): void => {
    feedbackOpen = true;
    queueMicrotask(() => feedbackInput?.focus());
  };

  const denyWithFeedback = (e: SubmitEvent): void => {
    e.preventDefault();
    const reason = feedback.trim();
    void answer('deny', reason ? { reason } : {});
  };

  const btn =
    'inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 disabled:opacity-50';
</script>

{#if item.state !== 'pending'}
  <RequestSettled {item} decision={requests?.decision(item.requestId)} />
{:else}
  <div
    class="rounded-lg border border-amber-500/60 bg-amber-500/5 p-3 text-sm shadow-xs"
    role="group"
    aria-label="Permission request: {item.toolName}"
    data-request-id={item.requestId}
  >
    <div class="flex items-center gap-2 text-amber-900 dark:text-amber-200">
      <HandIcon class="size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium">{item.title ?? `Allow ${item.toolName}?`}</span>
    </div>

    <div class="mt-2 space-y-1.5">
      {#if command}
        <pre
          class="bg-background max-h-48 overflow-auto rounded-md border px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{command}</pre>
        {#if str(input.description)}
          <p class="text-muted-foreground text-xs">{str(input.description)}</p>
        {/if}
      {:else if diffs}
        {#if str(input.file_path)}
          <p class="text-muted-foreground font-mono text-xs">{str(input.file_path)}</p>
        {/if}
        {#each diffs as d, i (i)}
          <DiffView diff={d.diff} />
        {/each}
      {:else}
        {#if target}
          <p class="font-mono text-xs break-all">{target}</p>
        {/if}
        <details class="text-xs">
          <summary class="text-muted-foreground cursor-pointer">Input</summary>
          <pre
            class="bg-background mt-1 max-h-48 overflow-auto rounded-md border px-2 py-1.5 font-mono whitespace-pre-wrap">{prettyJson(
              item.input,
            )}</pre>
        </details>
      {/if}
      {#if item.decisionReason}
        <p class="text-muted-foreground text-xs">{item.decisionReason}</p>
      {/if}
    </div>

    {#if requests}
      <div class="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          class="{btn} border-amber-600 bg-amber-500 text-amber-950 hover:bg-amber-400"
          data-autofocus
          disabled={busy}
          onclick={() => answer('allow')}>Allow</button
        >
        {#each suggestions as s, i (i)}
          <button
            type="button"
            class="{btn} bg-background hover:bg-muted"
            disabled={busy}
            onclick={() => answer('allowAlways', { suggestionIndex: i })}
            >{suggestionLabel(s)}</button
          >
        {/each}
        {#if !feedbackOpen}
          <button
            type="button"
            class="{btn} bg-background hover:bg-muted"
            disabled={busy}
            onclick={() => answer('deny')}>Deny</button
          >
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground px-1 text-xs underline-offset-2 hover:underline"
            disabled={busy}
            onclick={openFeedback}>Deny with feedback…</button
          >
        {/if}
      </div>
      {#if feedbackOpen}
        <form class="mt-2 flex items-center gap-1.5" onsubmit={denyWithFeedback}>
          <input
            bind:this={feedbackInput}
            bind:value={feedback}
            class="bg-background h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
            placeholder="Tell Claude what to do instead (optional)"
            aria-label="Feedback for Claude"
            onkeydown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                feedbackOpen = false;
              }
            }}
          />
          <button type="submit" class="{btn} bg-background hover:bg-muted" disabled={busy}
            >Deny</button
          >
        </form>
      {/if}
      {#if error}
        <p class="text-destructive mt-2 text-xs" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
{/if}

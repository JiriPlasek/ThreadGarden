<script lang="ts">
  import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
  import { chatActions } from '../context';
  import { prettyJson } from '../tools';
  import AssistantText from './AssistantText.svelte';
  import RequestSettled from './RequestSettled.svelte';
  import { planText, suggestionLabel, type RequestItem } from './requests';

  /**
   * ExitPlanMode (spec §6.4): the plan, rendered with the sanitized markdown
   * renderer, and Approve / Keep planning. Approving allows the tool call;
   * keeping planning denies it with the user's feedback as the message Claude
   * reads. Rules Claude Code suggests with the approval (e.g. "accept edits")
   * are offered as extra approve buttons.
   */
  let { item }: { item: RequestItem } = $props();

  const requests = chatActions().requests;
  const plan = $derived(planText(item.input));

  let feedback = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const answer = async (
    decision: 'allow' | 'allowAlways' | 'deny',
    suggestionIndex?: number,
  ): Promise<void> => {
    if (!requests || busy) return;
    busy = true;
    error = null;
    const reason = feedback.trim();
    try {
      await requests.respond({
        requestId: item.requestId,
        decision,
        ...(suggestionIndex === undefined ? {} : { suggestionIndex }),
        ...(decision === 'deny' ? { reason: reason || 'The user wants to keep planning.' } : {}),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
    // On success the card stays disabled until the service settles the request:
    // a second answer would be refused.
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
    aria-label="Plan approval"
    data-request-id={item.requestId}
  >
    <div class="flex items-center gap-2 text-amber-900 dark:text-amber-200">
      <ClipboardListIcon class="size-4 shrink-0" aria-hidden="true" />
      <span class="font-medium">Claude has a plan</span>
    </div>
    <div class="bg-background mt-2 max-h-[28rem] overflow-auto rounded-md border px-3 py-2">
      {#if plan}
        <AssistantText item={{ id: `${item.id}:plan`, markdown: plan, streaming: false }} />
      {:else}
        <pre class="font-mono text-xs whitespace-pre-wrap">{prettyJson(item.input)}</pre>
      {/if}
    </div>

    {#if requests}
      <textarea
        bind:value={feedback}
        rows="2"
        class="bg-background mt-2 w-full resize-y rounded-md border px-2 py-1 text-xs"
        placeholder="What should change? (optional, sent with Keep planning)"
        aria-label="Feedback on the plan"
        disabled={busy}></textarea>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          class="{btn} border-amber-600 bg-amber-500 text-amber-950 hover:bg-amber-400"
          data-autofocus
          disabled={busy}
          onclick={() => answer('allow')}>Approve</button
        >
        {#each item.suggestions.slice(0, 3) as s, i (i)}
          <button
            type="button"
            class="{btn} bg-background hover:bg-muted"
            disabled={busy}
            onclick={() => answer('allowAlways', i)}>Approve · {suggestionLabel(s)}</button
          >
        {/each}
        <button
          type="button"
          class="{btn} bg-background hover:bg-muted"
          disabled={busy}
          onclick={() => answer('deny')}>Keep planning</button
        >
      </div>
      {#if error}
        <p class="text-destructive mt-2 text-xs" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
{/if}

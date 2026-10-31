<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { SUBAGENT_TOOLS, type ToolCallItem } from '../rows';
  import { editDiffs, prettyJson, str, summarize } from '../tools';
  import DiffView from './DiffView.svelte';
  import SubagentGroup from './SubagentGroup.svelte';
  import ToolStatus from './ToolStatus.svelte';

  /**
   * One tool call as a compact row ("Bash · npm test · exit 0") that expands to
   * its input and output (spec §6.4). Edits show diffs; Agent/Task calls group
   * the subagent's items under them.
   */
  let { item, children = [] }: { item: ToolCallItem; children?: ChatItem[] } = $props();

  let open = $state(false);
  const summary = $derived(summarize(item));
  const pairs = $derived(editDiffs(item));
  const input = $derived(
    typeof item.input === 'object' && item.input !== null
      ? (item.input as Record<string, unknown>)
      : {},
  );
  /** For edits, a successful result only repeats "file updated": shown on failure only. */
  const showResult = $derived(
    item.resultText !== undefined && item.resultText !== '' && (!pairs || item.status === 'error'),
  );
</script>

{#if SUBAGENT_TOOLS.has(item.name)}
  <SubagentGroup {item} {children} />
{:else}
  <div class="text-xs">
    <button
      type="button"
      class="hover:bg-muted/60 flex w-full max-w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <ChevronRightIcon
        class="text-muted-foreground size-4 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      <ToolStatus status={item.status} />
      <span class="shrink-0 font-medium">{summary.verb}</span>
      {#if summary.target}
        <span class="text-muted-foreground min-w-0 truncate font-mono">{summary.target}</span>
      {/if}
      {#if summary.stats}
        <span class="shrink-0 font-mono">
          <span class="text-emerald-700 dark:text-emerald-400">+{summary.stats.added}</span>
          <span class="text-red-700 dark:text-red-400">−{summary.stats.removed}</span>
        </span>
      {/if}
      {#if summary.detail}
        <span
          class="shrink-0 {item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
          >· {summary.detail}</span
        >
      {/if}
    </button>

    {#if open}
      <div class="mt-1 mb-1.5 flex flex-col gap-1.5 pl-6">
        {#if pairs}
          {#each pairs as pair, i (i)}
            <DiffView diff={pair.diff} />
          {/each}
        {:else if item.name === 'Bash'}
          {#if str(input.description)}
            <div class="text-muted-foreground">{str(input.description)}</div>
          {/if}
          <pre
            class="bg-muted overflow-x-auto rounded p-2 font-mono text-[0.6875rem] leading-snug whitespace-pre-wrap">$ {str(
              input.command,
            )}</pre>
        {:else}
          <div>
            <div class="text-muted-foreground mb-0.5">Input</div>
            <pre
              class="bg-muted max-h-60 overflow-auto rounded p-2 font-mono text-[0.6875rem] leading-snug">{prettyJson(
                item.input,
              )}</pre>
          </div>
        {/if}

        {#if showResult}
          <div>
            <div class="text-muted-foreground mb-0.5">
              {item.status === 'error' ? 'Error' : 'Output'}
            </div>
            <pre
              class="bg-muted max-h-80 overflow-auto rounded p-2 font-mono text-[0.6875rem] leading-snug whitespace-pre-wrap {item.status ===
              'error'
                ? 'text-destructive'
                : ''}">{item.resultText}</pre>
            {#if item.resultTruncated}
              <p class="text-muted-foreground mt-0.5 italic">Output truncated</p>
            {/if}
          </div>
        {:else if item.status === 'running'}
          <p class="text-muted-foreground italic">Running…</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

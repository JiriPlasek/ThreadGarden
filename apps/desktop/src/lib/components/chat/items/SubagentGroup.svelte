<script lang="ts">
  import type { ChatItem } from '@pahub/protocol';
  import BotIcon from '@lucide/svelte/icons/bot';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { buildRows, type ToolCallItem } from '../rows';
  import { str, summarize } from '../tools';
  import AssistantText from './AssistantText.svelte';
  import ItemBoundary from './ItemBoundary.svelte';
  import ItemView from './ItemView.svelte';
  import ToolGroup from './ToolGroup.svelte';
  import ToolStatus from './ToolStatus.svelte';
  import UnknownItem from './UnknownItem.svelte';

  /**
   * An Agent/Task call with the subagent's own items grouped under it and its
   * live status (spec §6.4). Collapsed it shows the step count and, while
   * running, the latest step.
   */
  let { item, children = [] }: { item: ToolCallItem; children?: ChatItem[] } = $props();

  const SHOWN = 100;
  let open = $state(false);
  let showEarlier = $state(false);

  const summary = $derived(summarize(item));
  const rows = $derived(buildRows(children));
  const visible = $derived(showEarlier ? rows : rows.slice(-SHOWN));
  const prompt = $derived(
    str((item.input as Record<string, unknown> | null | undefined)?.prompt ?? ''),
  );
  const latest = $derived.by(() => {
    const last = children.at(-1);
    if (!last) return '';
    if (last.kind === 'toolCall') {
      const s = summarize(last);
      return `${s.verb} ${s.target}`.trim();
    }
    if (last.kind === 'assistantText') return last.markdown.split('\n', 1)[0] ?? '';
    return '';
  });
  const steps = $derived(`${children.length} ${children.length === 1 ? 'step' : 'steps'}`);
  const statusText = $derived(
    item.status === 'running' ? 'Running' : item.status === 'error' ? 'Failed' : 'Done',
  );
</script>

<div class="rounded-md border text-xs">
  <button
    type="button"
    class="hover:bg-muted/60 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <ChevronRightIcon
      class="text-muted-foreground size-4 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
      aria-hidden="true"
    />
    <ToolStatus status={item.status} />
    <BotIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
    <span class="min-w-0 truncate font-medium">{summary.target || item.name}</span>
    {#if summary.detail}
      <span class="bg-muted text-muted-foreground shrink-0 rounded px-1 py-px font-mono"
        >{summary.detail}</span
      >
    {/if}
    <span class="text-muted-foreground shrink-0">· {statusText} · {steps}</span>
    {#if item.status === 'running' && latest && !open}
      <span class="text-muted-foreground min-w-0 truncate italic">· {latest}</span>
    {/if}
  </button>

  {#if open}
    <div
      class="flex flex-col gap-1.5 border-t px-2 py-2"
      role="group"
      aria-label="Subagent: {summary.target || item.name}"
    >
      {#if prompt}
        <details class="text-muted-foreground">
          <summary class="hover:text-foreground cursor-pointer select-none">Prompt</summary>
          <div class="mt-1 border-l pl-3 break-words whitespace-pre-wrap">{prompt}</div>
        </details>
      {/if}
      {#if !showEarlier && rows.length > SHOWN}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground self-start"
          onclick={() => (showEarlier = true)}>Show {rows.length - SHOWN} earlier steps</button
        >
      {/if}
      {#each visible as row (row.key)}
        {#if row.kind === 'item'}
          <ItemView item={row.item} children={row.children} nested />
        {:else if row.kind === 'unknownGroup'}
          <ItemBoundary item={row.items}><UnknownItem items={row.items} /></ItemBoundary>
        {:else}
          <ItemBoundary item={row.items}
            ><ToolGroup name={row.name} items={row.items} /></ItemBoundary
          >
        {/if}
      {/each}
      {#if item.resultText}
        <div class="border-t pt-1.5">
          <div class="text-muted-foreground mb-0.5">Result</div>
          <AssistantText
            item={{ id: `${item.id}:result`, markdown: item.resultText, streaming: false }}
          />
          {#if item.resultTruncated}
            <p class="text-muted-foreground mt-0.5 italic">Output truncated</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

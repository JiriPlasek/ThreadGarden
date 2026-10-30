<script lang="ts">
  import { computeDiff, toSplit } from '../diff';

  /**
   * A file edit as a diff (spec §6.4): unified by default, side by side on
   * request, with line numbers. Long diffs show their first rows until expanded.
   */
  let { oldText, newText }: { oldText: string; newText: string } = $props();

  const LIMIT = 300;
  let mode = $state<'unified' | 'split'>('unified');
  let showAll = $state(false);

  const diff = $derived(computeDiff(oldText, newText));
  const unified = $derived(showAll ? diff.rows : diff.rows.slice(0, LIMIT));
  const split = $derived.by(() => {
    const rows = toSplit(diff.rows);
    return showAll ? rows : rows.slice(0, LIMIT);
  });
  const total = $derived(mode === 'unified' ? diff.rows.length : toSplit(diff.rows).length);

  const tone = (type: string): string =>
    type === 'add'
      ? 'bg-emerald-500/12 text-emerald-950 dark:text-emerald-100'
      : type === 'del'
        ? 'bg-red-500/12 text-red-950 dark:text-red-100'
        : '';
  const mark = (type: string): string => (type === 'add' ? '+' : type === 'del' ? '-' : ' ');
</script>

<div class="overflow-hidden rounded-md border text-xs">
  <div class="bg-muted/50 flex items-center gap-2 border-b px-2 py-1">
    <span class="text-muted-foreground">
      <span class="text-emerald-700 dark:text-emerald-400">+{diff.added}</span>
      <span class="text-red-700 dark:text-red-400">−{diff.removed}</span>
    </span>
    <div class="ml-auto flex gap-0.5" role="group" aria-label="Diff layout">
      <button
        type="button"
        class="rounded px-1.5 py-0.5 {mode === 'unified'
          ? 'bg-background text-foreground shadow-xs'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={mode === 'unified'}
        onclick={() => (mode = 'unified')}>Unified</button
      >
      <button
        type="button"
        class="rounded px-1.5 py-0.5 {mode === 'split'
          ? 'bg-background text-foreground shadow-xs'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={mode === 'split'}
        onclick={() => (mode = 'split')}>Side by side</button
      >
    </div>
  </div>

  {#if diff.rows.length === 0}
    <p class="text-muted-foreground px-2 py-1.5">No changes.</p>
  {:else if mode === 'unified'}
    <div class="overflow-x-auto font-mono leading-5" data-diff-mode="unified">
      <div class="min-w-max">
        {#each unified as row, i (i)}
          {#if row.type === 'hunk'}
            <div class="bg-muted/40 text-muted-foreground px-2" data-diff="hunk">{row.text}</div>
          {:else}
            <div class="flex {tone(row.type)}" data-diff={row.type}>
              <span class="text-muted-foreground w-10 shrink-0 pr-1 text-right select-none"
                >{row.oldNo ?? ''}</span
              >
              <span class="text-muted-foreground w-10 shrink-0 pr-1 text-right select-none"
                >{row.newNo ?? ''}</span
              >
              <span class="w-4 shrink-0 text-center select-none" aria-hidden="true"
                >{mark(row.type)}</span
              >
              <span class="pr-3 whitespace-pre">{row.text}</span>
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-2 font-mono leading-5" data-diff-mode="split">
      {#each split as row, i (i)}
        {#if row.type === 'hunk'}
          <div class="bg-muted/40 text-muted-foreground col-span-2 px-2" data-diff="hunk">
            {row.text}
          </div>
        {:else}
          {#each [row.left, row.right] as side, s (s)}
            <div
              class="flex min-w-0 overflow-hidden {s === 0 ? 'border-r' : ''} {side
                ? tone(side.type)
                : 'bg-muted/30'}"
              data-diff={side?.type ?? 'empty'}
            >
              {#if side}
                <span class="text-muted-foreground w-10 shrink-0 pr-1 text-right select-none"
                  >{side.no}</span
                >
                <span class="w-4 shrink-0 text-center select-none" aria-hidden="true"
                  >{mark(side.type)}</span
                >
                <span class="min-w-0 pr-2 break-all whitespace-pre-wrap">{side.text}</span>
              {/if}
            </div>
          {/each}
        {/if}
      {/each}
    </div>
  {/if}

  {#if !showAll && total > LIMIT}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground w-full border-t px-2 py-1 text-left"
      onclick={() => (showAll = true)}>Show all {total.toLocaleString()} lines</button
    >
  {/if}
</div>

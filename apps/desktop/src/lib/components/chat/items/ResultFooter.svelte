<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import { finishedAt, fullTime } from '#lib/format/time.js';
  import { duration, tokens } from '../format';

  /**
   * The end-of-turn line: how long the turn took, the tokens it added and
   * when it finished ("Turn finished · 13.1 s · 14k tokens · 6:04 AM"), or
   * that it failed. The tokens are this turn's new ones: uncached input, cache
   * writes and output. Cache reads, the earlier context read again on every
   * step, are left out (the tooltip says how many). No cost: the SDK's is the
   * whole chat's running total at API prices.
   */
  let { item }: { item: Extract<ChatItem, { kind: 'result' }> } = $props();

  type Segment = { text: string; title?: string };

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage = $derived.by((): Segment | null => {
    const u = (typeof item.usage === 'object' && item.usage !== null ? item.usage : {}) as Record<
      string,
      unknown
    >;
    const input = num(u.input_tokens);
    const written = num(u.cache_creation_input_tokens);
    const read = num(u.cache_read_input_tokens);
    const output = num(u.output_tokens);
    const added = input + written + output;
    if (added + read === 0) return null;
    return {
      text: `${tokens(added)} tokens`,
      title:
        `New this turn: ${tokens(input)} input, ${tokens(written)} cache writes, ` +
        `${tokens(output)} output. Not counted: ${tokens(read)} cache reads ` +
        '(the earlier context, read again).',
    };
  });
  const segments = $derived(
    [
      { text: item.isError ? 'Turn ended with an error' : 'Turn finished' },
      item.durationMs !== undefined ? { text: duration(item.durationMs) } : null,
      usage,
      item.ts !== undefined ? { text: finishedAt(item.ts), title: fullTime(item.ts) } : null,
    ].filter((s): s is Segment => s !== null && s.text !== ''),
  );
</script>

<div
  class="flex items-center gap-2 text-[0.6875rem] {item.isError
    ? 'text-destructive'
    : 'text-muted-foreground'}"
>
  <span class="bg-border h-px flex-1" aria-hidden="true"></span>
  <span
    >{#each segments as s, i (i)}{#if i > 0}{' · '}{/if}<span title={s.title}>{s.text}</span
      >{/each}</span
  >
  <span class="bg-border h-px flex-1" aria-hidden="true"></span>
</div>

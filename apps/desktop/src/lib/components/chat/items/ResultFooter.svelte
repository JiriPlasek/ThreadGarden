<script lang="ts">
  import type { ChatItem } from '@threadgarden/protocol';
  import { duration, tokens, usd } from '../format';

  /** The end-of-turn line: duration, cost and tokens, or that the turn failed. */
  let { item }: { item: Extract<ChatItem, { kind: 'result' }> } = $props();

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage = $derived.by(() => {
    const u = (typeof item.usage === 'object' && item.usage !== null ? item.usage : {}) as Record<
      string,
      unknown
    >;
    const input =
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    const output = num(u.output_tokens);
    return input + output > 0 ? `${tokens(input)} in · ${tokens(output)} out` : null;
  });
  const label = $derived(
    [
      item.isError ? 'Turn ended with an error' : 'Turn finished',
      item.durationMs !== undefined ? duration(item.durationMs) : null,
      item.costUsd !== undefined ? usd(item.costUsd) : null,
      usage,
    ]
      .filter((p): p is string => p !== null)
      .join(' · '),
  );
</script>

<div
  class="flex items-center gap-2 text-[0.6875rem] {item.isError
    ? 'text-destructive'
    : 'text-muted-foreground'}"
>
  <span class="bg-border h-px flex-1" aria-hidden="true"></span>
  <span>{label}</span>
  <span class="bg-border h-px flex-1" aria-hidden="true"></span>
</div>

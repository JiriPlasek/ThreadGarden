<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import { describeError, type ReportUiError } from '#lib/ui-errors.js';

  /**
   * The app-wide error boundary: an error nothing else handled shows "Something
   * went wrong" with Try again and Reload instead of a dead page, and goes to
   * the service log (`report`) so it can be found and fixed.
   */
  let {
    report,
    reload = () => location.reload(),
    children,
  }: { report: ReportUiError; reload?: () => void; children: Snippet } = $props();
</script>

<svelte:boundary onerror={(error) => report('render', error)}>
  {@render children()}

  {#snippet failed(error, reset)}
    <div
      role="alert"
      class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h1 class="text-base font-semibold">Something went wrong</h1>
      <p class="text-muted-foreground max-w-prose text-sm break-words">
        {describeError(error).message}
      </p>
      <p class="text-muted-foreground max-w-prose text-xs">
        The details are in Threadgarden's log. Your chats are not affected.
      </p>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" onclick={reset}>Try again</Button>
        <Button size="sm" onclick={reload}>Reload</Button>
      </div>
    </div>
  {/snippet}
</svelte:boundary>

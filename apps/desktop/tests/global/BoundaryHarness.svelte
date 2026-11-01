<script lang="ts">
  import ErrorBoundary from '../../src/lib/components/ErrorBoundary.svelte';
  import type { ReportUiError } from '../../src/lib/ui-errors';

  let { report, reload }: { report: ReportUiError; reload: () => void } = $props();
  let broken = $state(false);

  const value = (): string => {
    if (broken) throw new Error('broken on purpose');
    return 'fine';
  };
</script>

<ErrorBoundary {report} {reload}>
  <p>{value()}</p>
  <button type="button" onclick={() => (broken = true)}>Break</button>
</ErrorBoundary>

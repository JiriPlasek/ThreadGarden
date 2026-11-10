<script lang="ts">
  import { providerMarks } from '#lib/assets/provider-marks.js';
  let { codex }: { codex: boolean } = $props();
  const label = $derived(codex ? 'Codex (ChatGPT)' : 'Claude');
</script>

<span
  role="img"
  aria-label={label}
  title={label}
  class="inline-flex size-3 shrink-0 items-center justify-center"
>
  <svg viewBox="0 0 24 24" class="size-3" fill="currentColor" aria-hidden="true">
    <path d={codex ? providerMarks.openai : providerMarks.claude} />
  </svg>
</span>

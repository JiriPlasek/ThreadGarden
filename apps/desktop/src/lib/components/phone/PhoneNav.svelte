<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';

  /**
   * The phone's top bar: Back to the level above (as the back gesture does),
   * what is shown, and the level's own actions.
   */
  let {
    back,
    onBack,
    title,
    actions,
  }: {
    /** What Back returns to ("Places", "Chats"). */
    back: string;
    onBack: () => void;
    title?: string;
    actions?: Snippet;
  } = $props();
</script>

<header class="bg-background flex h-12 shrink-0 items-center gap-1 border-b px-1">
  <button
    type="button"
    class="hover:bg-accent flex h-11 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1 text-sm"
    aria-label="Back to {back.toLowerCase()}"
    onclick={onBack}
  >
    <ChevronLeftIcon class="size-5" aria-hidden="true" />
    {back}
  </button>
  <span class="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? ''}</span>
  {@render actions?.()}
</header>

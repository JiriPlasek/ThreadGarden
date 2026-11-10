<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte';

  let {
    open = $bindable(false),
    onConfirm,
  }: {
    open?: boolean;
    onConfirm: () => void | Promise<void>;
  } = $props();
</script>

<ConfirmDialog
  bind:open
  title="Enable bypass permissions?"
  description="Claude will be able to run tools and change files without asking for approval. Only enable this in an environment you trust."
  confirmLabel="Enable bypass permissions"
  {onConfirm}
/>

<script lang="ts">
  import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';

  /**
   * A yes/no confirmation. `onConfirm` may be async: the dialog stays open (buttons
   * disabled) until it settles, then closes; a thrown error is shown in the dialog.
   */
  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    onConfirm,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
  } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (open) error = null;
  });

  const confirm = async (e: MouseEvent): Promise<void> => {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await onConfirm();
      open = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content size="sm" class="gap-4 p-5">
    <AlertDialog.Header>
      <AlertDialog.Title class="text-base">{title}</AlertDialog.Title>
      {#if description}
        <AlertDialog.Description class="text-sm">{description}</AlertDialog.Description>
      {/if}
    </AlertDialog.Header>
    {#if error}
      <p class="text-destructive text-sm" role="alert">{error}</p>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel size="sm" disabled={busy}>{cancelLabel}</AlertDialog.Cancel>
      <AlertDialog.Action
        size="sm"
        variant={destructive ? 'destructive' : 'default'}
        disabled={busy}
        onclick={confirm}>{confirmLabel}</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

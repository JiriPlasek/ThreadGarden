<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';

  /**
   * A yes/no confirmation. `onConfirm` may be async: the dialog stays open (buttons
   * disabled) until it settles, then closes; a thrown error is shown in the dialog.
   * `children` adds content below the description (e.g. the agents an action stops).
   * `focusAfterConfirm` names where focus goes once a confirmed dialog closes,
   * for when the control that opened it is gone (default: back to that control).
   */
  let {
    open = $bindable(false),
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    onConfirm,
    focusAfterConfirm,
    children,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
    focusAfterConfirm?: () => HTMLElement | null | undefined;
    children?: Snippet;
  } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);
  /** The last close followed a successful confirm. */
  let confirmed = false;

  $effect(() => {
    if (open) {
      error = null;
      confirmed = false;
    }
  });

  const closeAutoFocus = (e: Event): void => {
    const target = confirmed ? focusAfterConfirm?.() : undefined;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const confirm = async (e: MouseEvent): Promise<void> => {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await onConfirm();
      confirmed = true;
      open = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content size="sm" class="gap-4 p-5" onCloseAutoFocus={closeAutoFocus}>
    <AlertDialog.Header>
      <AlertDialog.Title class="text-base">{title}</AlertDialog.Title>
      {#if description}
        <AlertDialog.Description class="text-sm">{description}</AlertDialog.Description>
      {/if}
    </AlertDialog.Header>
    {@render children?.()}
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

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import AttachmentPreview from './AttachmentPreview.svelte';
  import {
    attachedTags,
    editorSelection,
    editorText,
    EditorHistory,
    renderEditor,
    setEditorSelection,
    wholeChips,
    type EditorSnapshot,
  } from './editor';
  import type { AttachmentsState } from './tags';
  let {
    text,
    attachments,
    element = $bindable(null),
    label,
    placeholder,
    disabled,
    controls,
    activeId,
    onChange,
    onkeydown,
    onpaste,
    oncopy,
    onCaret,
    onblur,
  }: {
    text: string;
    attachments: AttachmentsState;
    element?: HTMLDivElement | null;
    label: string;
    placeholder: string;
    disabled: boolean;
    controls?: string;
    activeId?: string;
    onChange: (value: string, typed: boolean) => void;
    onkeydown: (e: KeyboardEvent) => void;
    onpaste: (e: ClipboardEvent) => void;
    oncopy: (e: ClipboardEvent, text: string) => void;
    onCaret: () => void;
    onblur: () => void;
  } = $props();
  const history = new EditorHistory();
  let previous: EditorSnapshot = { text: untrack(() => text), start: 0, end: 0 };
  let composing = false;
  let before: EditorSnapshot | undefined;
  let renderedAttachments: AttachmentsState | undefined;
  const snapshot = (): EditorSnapshot => ({
    text: element ? editorText(element) : text,
    ...(element ? editorSelection(element) : { start: 0, end: 0 }),
  });
  const apply = (value: EditorSnapshot, record = true): void => {
    if (!element) return;
    if (record) history.record(before ?? snapshot(), value);
    before = undefined;
    renderEditor(element, value.text, attachments);
    renderedAttachments = attachments;
    setEditorSelection(element, value.start, value.end);
    previous = value;
    onChange(value.text, false);
  };
  export const selection = () =>
    element ? editorSelection(element) : { start: text.length, end: text.length };
  export const resetHistory = (): void => history.clear();
  export const select = (start: number, end = start): void => {
    if (element) setEditorSelection(element, start, end);
  };
  export const replace = (start: number, end: number, insert: string): void => {
    if (!element || disabled) return;
    element.focus();
    const range = wholeChips(text, attachments, { start, end });
    const next = text.slice(0, range.start) + insert + text.slice(range.end);
    apply({ text: next, start: range.start + insert.length, end: range.start + insert.length });
  };
  export const caretTop = (): number => {
    if (!element) return 0;
    const range = document.getSelection()?.rangeCount
      ? document.getSelection()!.getRangeAt(0)
      : null;
    const rect = range?.getBoundingClientRect?.();
    return rect ? Math.max(0, rect.top - element.getBoundingClientRect().top) : 0;
  };
  $effect(() => {
    const value = text;
    const state = attachments;
    const el = element;
    if (!el || composing) return;
    // Native input already reconciles its DOM. External load/send clears history.
    const external = editorText(el) !== value;
    if (external || renderedAttachments !== state || !el.childNodes.length) {
      const selection = editorSelection(el);
      renderEditor(el, value, state);
      renderedAttachments = state;
      if (external) history.clear();
      else if (document.activeElement === el)
        setEditorSelection(el, selection.start, selection.end);
      previous = { text: value, ...selection };
    }
  });
  const input = (): void => {
    if (!element) return;
    const current = snapshot();
    if (composing) {
      onChange(current.text, true);
      return;
    }
    history.record(before ?? previous, current);
    before = undefined;
    renderEditor(element, current.text, attachments);
    renderedAttachments = attachments;
    setEditorSelection(element, current.start, current.end);
    previous = current;
    onChange(current.text, true);
  };
  /**
   * Deletes a selection, or the chip next to the caret, whole (true: done, the
   * native delete must not run). Undefined chips and plain text are left to it.
   */
  const deleteChips = (backward: boolean): boolean => {
    const range = selection();
    const adjacent = attachedTags(text, attachments).find((tag) =>
      backward ? tag.end === range.start : tag.start === range.end,
    );
    if (range.start === range.end && !adjacent) return false;
    replace(
      adjacent && range.start === range.end ? adjacent.start : range.start,
      adjacent && range.start === range.end ? adjacent.end : range.end,
      '',
    );
    return true;
  };
  const keydown = (e: KeyboardEvent): void => {
    if (e.target !== element) {
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        e.target instanceof HTMLElement &&
        e.target.dataset.attachment
      ) {
        e.preventDefault();
        preview(e.target, true);
      }
      if (e.key === 'Escape') hide();
      return;
    }
    onkeydown(e);
    if (e.defaultPrevented || e.isComposing || composing || disabled) return;
    const range = selection();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      const value =
        e.shiftKey || e.key.toLowerCase() === 'y'
          ? history.redo(snapshot())
          : history.undo(snapshot());
      if (value) apply(value, false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      replace(range.start, range.end, '\n');
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && deleteChips(e.key === 'Backspace')) {
      e.preventDefault();
    }
    if (
      !mod &&
      !e.altKey &&
      !e.shiftKey &&
      range.start === range.end &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      const adjacent = attachedTags(text, attachments).find((tag) =>
        e.key === 'ArrowLeft' ? tag.end === range.start : tag.start === range.end,
      );
      if (adjacent) {
        e.preventDefault();
        select(e.key === 'ArrowLeft' ? adjacent.start : adjacent.end);
      }
    }
  };
  const beforeinput = (e: InputEvent): void => {
    if (composing) return;
    before = snapshot();
    if (e.inputType.startsWith('format')) e.preventDefault();
    else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      const s = selection();
      replace(s.start, s.end, '\n');
    } else if (
      // Keyboards that send no Backspace/Delete key (Android's: "Unidentified") delete this way.
      (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') &&
      !disabled &&
      deleteChips(e.inputType === 'deleteContentBackward')
    ) {
      e.preventDefault();
    } else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      const value =
        e.inputType === 'historyUndo' ? history.undo(snapshot()) : history.redo(snapshot());
      if (value) apply(value, false);
    }
  };
  const copy = (e: ClipboardEvent, cut = false): void => {
    const s = wholeChips(text, attachments, selection());
    if (s.start === s.end) return;
    oncopy(e, text.slice(s.start, s.end));
    if (cut && e.defaultPrevented) replace(s.start, s.end, '');
  };
  let hovered = $state<{
    label: string;
    kind: string;
    number: number;
    left: number;
    top: number;
    anchor: HTMLElement;
  } | null>(null);
  let pinned = $state(false);
  let previewScroll = $state<HTMLPreElement | null>(null);
  let previewElement = $state<HTMLDivElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keep = (): void => clearTimeout(timer);
  const hide = (): void => {
    keep();
    hovered = null;
    pinned = false;
  };
  const leave = (): void => {
    keep();
    if (!pinned)
      timer = setTimeout(() => {
        if (!pinned) hide();
      }, 180);
  };
  const preview = (chip: HTMLElement, pin = false): void => {
    if (pinned && !pin) return;
    keep();
    const r = chip.getBoundingClientRect();
    hovered = {
      label: chip.dataset.attachment!,
      kind: chip.dataset.kind!,
      number: Number(chip.dataset.number),
      left: r.left,
      top: r.top - 6,
      anchor: chip,
    };
    pinned = pin;
  };
  const chipOf = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-attachment]') : null;
  $effect(() => {
    if (!hovered) return;
    const outside = (e: PointerEvent): void => {
      const target = e.target;
      if (
        target instanceof Node &&
        (previewElement?.contains(target) ||
          (element?.contains(target) &&
            target instanceof Element &&
            target.closest('[data-attachment]')))
      )
        return;
      hide();
    };
    document.addEventListener('pointerdown', outside, true);
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  });
  onDestroy(keep);
</script>

<!-- The browser owns editable text nodes; renderEditor creates only text and non-editable chips. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={element}
  role="textbox"
  aria-multiline="true"
  aria-label={label}
  aria-disabled={disabled}
  aria-autocomplete="list"
  aria-controls={controls}
  aria-activedescendant={activeId}
  contenteditable={!disabled}
  tabindex="0"
  data-placeholder={placeholder}
  class="chip-editor block min-h-9 max-h-60 w-full overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-sm leading-5 outline-none"
  oninput={input}
  onbeforeinput={beforeinput}
  {onpaste}
  oncopy={(e) => copy(e)}
  oncut={(e) => copy(e, true)}
  ondrop={(e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) {
      e.preventDefault();
      if (e.dataTransfer)
        onpaste(new ClipboardEvent('paste', { clipboardData: e.dataTransfer, cancelable: true }));
    }
  }}
  oncompositionstart={() => {
    composing = true;
    before = snapshot();
  }}
  oncompositionend={() => {
    composing = false;
    input();
  }}
  onkeydown={keydown}
  onkeyup={(e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onCaret();
  }}
  onmouseup={onCaret}
  {onblur}
  onpointerover={(e) => {
    const chip = chipOf(e);
    if (chip) preview(chip);
  }}
  onpointerout={leave}
  onfocusin={(e) => {
    const chip = chipOf(e);
    if (chip) preview(chip);
  }}
  onclick={(e) => {
    const chip = chipOf(e);
    if (chip) {
      preview(chip, true);
    }
    onCaret();
  }}
  onwheel={(e) => {
    const chip = chipOf(e);
    if (chip?.dataset.kind !== 'paste') return;
    if (!hovered) preview(chip);
    if (previewScroll) {
      e.preventDefault();
      previewScroll.scrollTop += e.deltaY;
    }
  }}
></div>
{#if hovered}
  <AttachmentPreview
    label={hovered.label}
    image={hovered.kind === 'image' ? attachments.images[hovered.number] : undefined}
    text={hovered.kind === 'paste' ? attachments.pastes[hovered.number]?.text : undefined}
    missing={hovered.kind === 'image' && !attachments.images[hovered.number]}
    left={hovered.left}
    top={hovered.top}
    anchor={hovered.anchor}
    bind:scrollElement={previewScroll}
    bind:element={previewElement}
    onmouseenter={keep}
    onmouseleave={leave}
  />
{/if}

<style>
  .chip-editor {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    cursor: text;
  }
  .chip-editor:empty::before {
    content: attr(data-placeholder);
    color: var(--muted-foreground);
    pointer-events: none;
  }
  .chip-editor[aria-disabled='true'] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .chip-editor :global(.attachment-chip) {
    display: inline-block;
    white-space: nowrap;
    border-radius: 0.3rem;
    background: color-mix(in srgb, #0ea5e9 15%, transparent);
    color: #0c4a6e;
    padding: 0 0.25rem;
    margin: 0 0.05rem;
    font-size: 0.85em;
    line-height: 1.35rem;
    cursor: pointer;
    user-select: all;
    vertical-align: baseline;
  }
  .chip-editor :global(.attachment-chip[data-missing]) {
    color: var(--muted-foreground);
  }
  :global([data-theme='dark']) .chip-editor :global(.attachment-chip:not([data-missing])) {
    color: #bae6fd;
  }
  .chip-editor :global(.attachment-chip:focus-visible) {
    outline: 2px solid var(--ring);
  }
</style>

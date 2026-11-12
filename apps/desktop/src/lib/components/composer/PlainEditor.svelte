<script lang="ts">
  import { caretLineTop } from './caret';
  import { attachedTags, wholeChips } from './editor';
  import type { AttachmentsState } from './tags';

  /**
   * The composer's box on the phone: a plain textarea, with the same surface
   * as `ChipEditor`. Android keyboards (Gboard) don't get along with a
   * contenteditable that renders its tags as chips: they compose and
   * autocorrect against text the editor keeps re-rendering, and send deletes
   * no chip can catch as a key. Here `[Image #N]` and `[Pasted text #N +K
   * lines]` are ordinary text; the attachments behind them work the same, and
   * a delete next to a tag takes the whole tag. Undo is the platform's own.
   */
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
    element?: HTMLTextAreaElement | null;
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

  const MAX_HEIGHT_PX = 240;

  const resize = (): void => {
    const el = element;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT_PX, el.scrollHeight)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  };

  // The text set from outside (a draft loaded, a message sent): the box follows.
  $effect(() => {
    const value = text;
    const el = element;
    if (!el) return;
    if (el.value !== value) el.value = value;
    resize();
  });

  export const selection = () =>
    element
      ? { start: element.selectionStart, end: element.selectionEnd }
      : { start: text.length, end: text.length };
  export const resetHistory = (): void => {};
  export const select = (start: number, end = start): void => {
    element?.setSelectionRange(start, end);
  };
  export const replace = (start: number, end: number, insert: string): void => {
    const el = element;
    if (!el || disabled) return;
    el.focus();
    el.setRangeText(insert, start, end, 'end');
    resize();
    onChange(el.value, false);
  };
  export const caretTop = (): number =>
    element ? caretLineTop(element, element.selectionStart) : 0;

  /**
   * A delete that would cut into a tag takes the whole tag. Gboard sends no
   * key, only the delete, and by then Chrome has already selected what it
   * deletes (the last character of `[Image #1]`, say); a hardware keyboard's
   * Backspace comes with the caret still collapsed next to the tag.
   */
  const beforeinput = (e: InputEvent): void => {
    if (e.isComposing || disabled) return;
    const backward = e.inputType === 'deleteContentBackward';
    if (!backward && e.inputType !== 'deleteContentForward') return;
    const { start, end } = selection();
    const adjacent =
      start === end
        ? attachedTags(text, attachments).find((t) => (backward ? t.end : t.start) === start)
        : undefined;
    const range = adjacent ?? wholeChips(text, attachments, { start, end });
    if (range.start === range.end || (range.start === start && range.end === end)) return;
    e.preventDefault();
    replace(range.start, range.end, '');
  };

  const copy = (e: ClipboardEvent, cut = false): void => {
    const { start, end } = selection();
    if (start === end) return;
    oncopy(e, text.slice(start, end));
    if (cut && e.defaultPrevented) replace(start, end, '');
  };
</script>

<textarea
  bind:this={element}
  rows="1"
  class="placeholder:text-muted-foreground block w-full resize-none overflow-hidden bg-transparent px-3 pt-2.5 pb-1 text-sm leading-5 outline-none disabled:cursor-not-allowed disabled:opacity-50"
  aria-label={label}
  aria-autocomplete="list"
  aria-controls={controls}
  aria-activedescendant={activeId}
  {placeholder}
  {disabled}
  oninput={(e) => {
    resize();
    onChange(e.currentTarget.value, true);
  }}
  onbeforeinput={beforeinput}
  {onkeydown}
  {onpaste}
  oncopy={(e) => copy(e)}
  oncut={(e) => copy(e, true)}
  onkeyup={(e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onCaret();
  }}
  onclick={onCaret}
  {onblur}></textarea>

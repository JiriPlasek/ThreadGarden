import { labelForPaste, tagsIn, type AttachmentsState } from './tags';

export type EditorSelection = { start: number; end: number };
export type EditorSnapshot = EditorSelection & { text: string };

/** No HTML from the clipboard is ever inserted into the editor. */
export const editorText = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.tagName === 'BR')
    return node.hasAttribute('data-editor-tail') ? '' : '\n';
  return [...node.childNodes].map(editorText).join('');
};

export const editorSelection = (el: HTMLElement): EditorSelection => {
  const selection = el.ownerDocument.getSelection();
  if (
    !selection?.rangeCount ||
    !el.contains(selection.anchorNode) ||
    !el.contains(selection.focusNode)
  ) {
    const end = editorText(el).length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  const prefix = range.cloneRange();
  prefix.selectNodeContents(el);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length };
};

export const setEditorSelection = (el: HTMLElement, start: number, end = start): void => {
  const point = (offset: number): [Node, number] => {
    let left = offset;
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]!;
      const length = editorText(node).length;
      if (left <= length) {
        if (node.nodeType === Node.TEXT_NODE) return [node, Math.max(0, left)];
        // A chip is one editing unit, even when restoring an old text offset.
        return [el, i + (left > length / 2 ? 1 : 0)];
      }
      left -= length;
    }
    return [el, el.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(end));
  const selection = el.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

export const attachedTags = (text: string, attachments: AttachmentsState) =>
  tagsIn(text).filter(
    (tag) =>
      tag.kind === 'image' ||
      (attachments.pastes[tag.number] &&
        tag.label === labelForPaste(tag.number, attachments.pastes[tag.number]!)),
  );

export const wholeChips = (
  text: string,
  attachments: AttachmentsState,
  selection: EditorSelection,
): EditorSelection => {
  let { start, end } = selection;
  for (const tag of attachedTags(text, attachments)) {
    if (start > tag.start && start < tag.end) start = tag.start;
    if (end > tag.start && end < tag.end) end = tag.end;
  }
  return { start, end };
};

export const renderEditor = (
  el: HTMLElement,
  text: string,
  attachments: AttachmentsState,
): void => {
  const fragment = document.createDocumentFragment();
  let start = 0;
  for (const tag of attachedTags(text, attachments)) {
    fragment.append(document.createTextNode(text.slice(start, tag.start)));
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', tag.label);
    chip.tabIndex = 0;
    chip.dataset.attachment = tag.label;
    chip.dataset.kind = tag.kind;
    chip.dataset.number = String(tag.number);
    chip.className = 'attachment-chip';
    if (tag.kind === 'image' && !attachments.images[tag.number]) chip.dataset.missing = 'true';
    chip.textContent = tag.label;
    fragment.append(chip);
    start = tag.end;
  }
  fragment.append(document.createTextNode(text.slice(start)));
  // A trailing newline needs a line box or browsers move subsequent typing
  // back before it. This sentinel has no logical text or selection length.
  if (text.endsWith('\n')) {
    const tail = document.createElement('br');
    tail.setAttribute('data-editor-tail', '');
    fragment.append(tail);
  }
  el.replaceChildren(fragment);
};

/** Explicit text history keeps chip deletion, cut, paste and IME edits undoable together. */
export class EditorHistory {
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];
  record = (before: EditorSnapshot, after: EditorSnapshot): void => {
    if (before.text === after.text) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  };
  undo = (current: EditorSnapshot): EditorSnapshot | undefined => {
    const previous = this.undoStack.pop();
    if (previous) this.redoStack.push(current);
    return previous;
  };
  redo = (current: EditorSnapshot): EditorSnapshot | undefined => {
    const next = this.redoStack.pop();
    if (next) this.undoStack.push(current);
    return next;
  };
  clear = (): void => {
    this.undoStack = [];
    this.redoStack = [];
  };
}

import { describe, expect, it } from 'vitest';
import {
  editorText,
  renderEditor,
  setEditorSelection,
  editorSelection,
  wholeChips,
  EditorHistory,
} from '../../src/lib/components/composer/editor';
import { emptyAttachments } from '../../src/lib/components/composer/tags';

describe('atomic attachment editor', () => {
  it('keeps a final newline editable without adding extra logical text', () => {
    const el = document.createElement('div');
    renderEditor(el, 'first\n', emptyAttachments());
    expect(el.querySelector('br[data-editor-tail]')).not.toBeNull();
    expect(editorText(el)).toBe('first\n');
  });
  it('renders known attachments as non-editable elements and treats clipboard HTML as text', () => {
    const el = document.createElement('div');
    const state = emptyAttachments();
    state.pastes[1] = { text: 'a\nb', id: 'abcd' };
    const text = '<img src=x onerror=alert(1)> [Pasted text #1 +2 lines] [Pasted text #9 +2 lines]';
    renderEditor(el, text, state);
    expect(editorText(el)).toBe(text);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelectorAll('[contenteditable="false"]')).toHaveLength(1);
  });

  it('selects chips only at their boundaries and expands partially selected chips for deletion', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const state = emptyAttachments();
    const text = 'a [Image #1] z';
    renderEditor(el, text, state);
    setEditorSelection(el, 2);
    expect(editorSelection(el)).toEqual({ start: 2, end: 2 });
    setEditorSelection(el, 12);
    expect(editorSelection(el)).toEqual({ start: 12, end: 12 });
    expect(wholeChips(text, state, { start: 3, end: 7 })).toEqual({ start: 2, end: 12 });
    el.remove();
  });

  it('restores a whole attachment and caret through undo and redo and clears redo after editing', () => {
    const history = new EditorHistory();
    const attached = { text: '[Image #1]', start: 10, end: 10 };
    const empty = { text: '', start: 0, end: 0 };
    history.record(empty, attached);
    expect(history.undo(attached)).toEqual(empty);
    expect(history.redo(empty)).toEqual(attached);
    history.undo(attached);
    history.record(empty, { text: 'new', start: 3, end: 3 });
    expect(history.redo(empty)).toBeUndefined();
  });
});

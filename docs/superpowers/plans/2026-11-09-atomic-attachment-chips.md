# Atomic attachment chips and usable previews

The owner's local review supersedes the original design's editable text badges:
attachments should be real, indivisible elements. Clicking a badge pins its
preview until an outside click; scrolling over a pasted-text badge scrolls its
preview even without clicking. These preview rules apply while composing and
to sent messages.

1. Replace the textarea/backdrop with a plain-text contenteditable editor whose
   attachment spans have `contenteditable=false`. Keep the existing text model,
   attachment registry and outgoing serialization.
2. Map DOM selection to logical text offsets. Cross badges with arrow keys and
   delete partially selected or adjacent badges as whole units. Preserve normal
   multiline input, IME composition, mentions, slash commands and focus behavior.
3. Keep explicit text/selection undo history for typing, badge insertion,
   deletion, cut and paste. Reset it on externally loaded messages.
4. Copy plain text plus a private clipboard representation containing the
   actual attachments. Renumber copied attachments in the destination draft.
   Reject clipboard HTML; keep drafts, scheduling and restart behavior intact.
5. Pin previews on click, dismiss on outside click or Escape, allow pointer
   entry into the preview and route wheel input over text badges into the
   preview's scrollable text.
6. Update component tests for the new editor element and verify atomic editing,
   clipboard round trips, IME undo, previews and performance in Chromium. Run
   the complete desktop suite, typecheck, lint and source formatting checks.

The local mock review remains at `http://127.0.0.1:1420`, with fake data only.

## Validation

- Complete desktop suite: 1,081 tests passed. After the browser caught a trailing
  newline caret issue, the fix and its new regression test passed alongside
  the composer, attachment and shortcut checks (37 tests).
- Chromium: all 8 attachment workflow, smoke and UI performance checks passed,
  including Shift+Enter, atomic deletion/undo, cut/paste with contents preserved,
  pinned previews, and wheel scrolling without moving the message list.
- Typing with three collapsed 5,000-line pastes: p90 2.5 ms (budget 16 ms).
- Desktop typecheck: 0 errors and 0 warnings; lint and source formatting passed.
- Native Tauri and macOS/Linux were not manually exercised.

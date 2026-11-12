# Attachment tags implementation plan

Continue item 3 of `../specs/2026-11-06-attachment-tags-design.md` in the
existing `worktree-ui-fixes` branch. Items 1, 2, 4 and 5 are already committed.

1. Add shared paste-block parsing and readable summaries. Add pure desktop
   helpers for exact tags, monotonic numbering, paste collapse/expansion,
   duplicate tags and highest-number image mapping. Test thresholds, malformed
   blocks, repeated tags, old references and round trips.
2. Cache composer attachment registries by draft key in InteractionState.
   Persist expanded pastes with the existing text-only draft API; defer expansion
   until the debounced write or an explicit read. Preserve registries for undo
   and remounts, clear on send, and carry them when New chat moves a draft.
3. Insert image and long-paste tags at the caret. Keep native textarea undo for
   insertions, label thumbnails, filter sent images by present tags, and use
   expanded text for send, scheduling, current/load and draft persistence.
4. Draw inline badges with a textarea mirror, synchronized wrapping and scroll.
   Hit-test badges for hover previews and provide keyboard-accessible previews.
   Missing image tags explain that the image must be attached again.
5. Render sent messages with image and paste badges, focus/hover previews and
   expandable full pastes. Clamp displayed text, preserve untagged thumbnails,
   and clean summaries in titles, lists, notifications and waiting/scheduled rows.
6. Verify component flows for attachment deletion/restoration, remount/restart,
   send and scheduling; run desktop, service and protocol suites, typecheck,
   lint, formatting, performance budgets and a production UI build. Review the
   final diff against the design and document any unavailable manual checks.

## Completed 2026-11-09

All six steps are implemented. Validation:

- Desktop: 1,076 tests passed (4 workers).
- Service: 1,462 passed, 52 intentionally skipped (2 workers).
- Protocol: 118 tests passed.
- Browser: attachment workflow, 15,000-line collapsed-paste typing, smoke and
  four UI performance checks passed (7 tests), against a production UI build.
  With three collapsed 5,000-line pastes, typing p90 was 4.3 ms (budget 16 ms).
- Service performance: 13 checks passed.
- Workspace typecheck and lint passed; changed source files are formatted.

The initial concurrent service run timed out in existing `git-state` and
`push-check` tests and hit Windows EBUSY cleanup errors. The complete service
suite passed with two workers. No native Tauri/manual app run was performed;
UI behavior was exercised in Chromium. The external to-do vault was left alone.

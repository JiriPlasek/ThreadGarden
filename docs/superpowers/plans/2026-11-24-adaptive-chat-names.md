# Adaptive chat names implementation plan

> For agentic workers: implement the independent engine/storage and UI tasks in isolated worktrees, then review the combined behavior.

**Goal:** Name chats from their actual conversation and refresh misleading automatic names without constant renaming or overwriting user choices.

**Architecture:** Extend the existing ChatTitles scheduler and local title metadata. Feed it the existing normalized chat view (main user/assistant text only), including provider-specific isolated title requests on latest main. The model may explicitly keep a name or defer while intent is unclear.

**Tech stack:** TypeScript, Svelte 5, SQLite, existing Claude/Codex adapters, Vitest.

**Spec:** User-approved naming proposal in this conversation. Defaults below are implementation choices, not additional user requirements.

## Requirements and proof

- [ ] Persist the last checked user message/count/time in Threadgarden metadata. Check after the first substantive user message, then three additional messages, then every five additional messages, without a time condition. Reopening/restarting alone must not trigger another call.
- [ ] Build bounded context from the first and recent user/assistant messages, excluding child agents, tools, synthetic notes and queued/unconsumed messages. Both live and imported history use the existing merged chat view.
- [ ] Parse a validated `{title: string | null}` decision. Null keeps the current name or defers. Invalid/failed output preserves the current name; later new context can retry.
- [ ] Serialize per chat and retain the existing global concurrency/timeout. A stale result must not overwrite a manual rename or newer conversation. Automatic checks never change custom names or take over externally owned names without an explicit request.
- [ ] Add `chat.regenerateTitle({sessionId}) -> {title, changed}` and a scoped header menu action. It works on old/paused chats without resuming a runtime, honors moved/moving/read-only boundaries, and keeps the previous name/draft until success. An explicit regeneration can replace a custom title; an intervening rename still wins.
- [ ] Cover message intervals/restarts/defer/keep/retry/stale work in engine tests, context filtering and handler safety in service tests, and pending/error/read-only/remote scope in UI tests.
- [ ] Run affected suites, lint/typecheck, independent review, and an isolated local preview before publishing a PR.

## Boundaries

No native transcript writes, native renames, chat resumes for naming, bulk renaming of history, new naming settings, unrelated PR changes, or build-directory copies. Builds and tests exclude logical CPUs 14 and 15 on this machine.

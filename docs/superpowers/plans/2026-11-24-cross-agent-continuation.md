# Cross-agent continuation implementation plan

**Goal:** Continue a Claude task in a new Codex chat, or vice versa, on the same machine and in the same working folder.

**Approved design:** A chat action opens a confirmation. It interrupts and ends Threadgarden's source session; tracked background tasks must first be stopped through the existing controls, exports readable history outside the project, and starts the other agent with a short instruction to inspect that history and the actual files before continuing. No source-model inference. The original chat remains readable; persisted reciprocal links connect both chats. Native sessions/caches are not converted. External processes must be stopped; unavailable detection requires the user's explicit confirmation, as with existing resume safety.

**Architecture:** Extend the chat handler where merged history, lifecycle and create invariants already live. Use the existing transfer lock for source exclusion. Add one local relation table, one chat RPC, optional links in chat.open, and a Markdown export helper in chat/continuation.ts. Exported histories are service-owned files, not repository changes. Use the target's usual permissions/default model, never copy bypass settings. Protocol phone inventory explicitly refuses the RPC locally; remote scopes route normally.

**Global constraints:** Do not change an existing PR. Branch from latest main. No raw Claude transcript access; normalize SDK history and live snapshots. Pin builds/tests off logical CPUs 14/15. No copied build directories. Preview locally before publishing.

- [x] Test and implement normalized transcript export, including tool results, subagent labels, errors and explicit image omissions. Exclude thinking, queued and unknown raw records. Keep the complete readable export; no hidden truncation.
- [x] Persist source/target links; test restart, idempotency and conflicting ids. Refuse moved/moving/unknown chats and missing runtimes before stopping the source. Lock through stop/history/export/create; await source shutdown with a bounded wait. Preserve the ended live view and returned queued drafts.
- [x] Add Continue in Codex/Claude to header menu, confirmation with stop/cost explanation, pending guard, retry-stable target id, error handling, scoped request and new tab. Show links in source and target headers. Hide on offline/read-only/moved copies.
- [x] Run focused service/protocol/UI proofs, typecheck/lint and native method contract. Review boundaries and failure paths, commit and launch isolated preview. No PR until requested.

Review: independent reviewer found and re-reviewed fixes for interrupted prepared handoffs, orphan exports and strict established-history reads. Regression tests reproduce all three. Stop timeout guards prevent a late interrupt from closing a source after the handoff has failed. UI tests cover opposite-provider labels, remote routing, explicit confirmation, retries and read-only hiding.

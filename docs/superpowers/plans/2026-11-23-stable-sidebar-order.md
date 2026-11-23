# Stable Sidebar Order Implementation Plan

**Goal:** Order chats and projects by the latest real user message, or the handoff timestamp while awaiting the user, without tool/stream noise.

**Architecture:** Add optional `sortAt` and shared `sidebarTime` in the protocol while preserving raw `lastActivity` for synchronization. Persist known user/attention timestamps and a stable missing-time baseline in Threadgarden SQLite; gather history through the existing SDK statistics pass. Merge live and history pages by the same key. Project ordering, search, merged machines and section headings use that key. Displayed relative times and their hover timestamps continue to use raw lastActivity.

**Constraints:** Claude data stays read-only through SDK/agents APIs. No new dependencies, settings or fabricated historical timestamps. Existing pin priority remains. Resume protection, copy freshness and archive age use raw activity. Base is latest main, independent of other open PRs.

- [x] Persist sidebar activity and backfill real prompt timestamps in the existing StatsCollector walk. Provide DB sidebar paging/project aggregation without changing raw activity queries.
- [x] Add optional protocol `sortAt`, timestamp-only comparator and frontend sidebar grouping/merge handling, preserving raw activity labels, preserving old-peer fallback.
- [x] Wire live user sends and attention transitions to the persisted activity. Keep streamed output off the sidebar key.
- [x] Make Catalog list/search/project order consistent, with bounded live/history merging and stable keyset pagination.
- [x] Prove stable order during streaming, user/handoff bumps, old histories, restart, pagination/overlay transitions, cross-machine ordering and freshness preservation. Run focused tests, full affected suites/static checks and independent review; open a focused PR.

**Interfaces:** `Db.recordUserMessage(id, at)`, `Db.recordNeedsYou(id, at)`, `Db.sidebarActivityOf(id)` returns `{ userAt, attentionAt? }`; SessionRow adds optional `userAt`, `attentionAt`, `sortAt`. `Db.listSessions(filter, limit, cursor, order = 'activity')` supports `order = 'sidebar'`; `Db.projectSidebarActivity(excludeIds)` aggregates history sort keys. `StatsCollector.result()` adds `lastUserAt` from real main user messages with known timestamps only. `sidebarTime({lastActivity, sortAt?})` returns sortAt or legacy lastActivity.

Validation: protocol 179 tests, desktop 1,261 tests, service 1,675 tests; real sidebar browser regression; bucket/indexer/quick-search performance budgets; workspace typecheck and lint. Review's handoff pagination finding was reproduced in three cases and fixed by tracking emitted transient/unread rows separately from pending overlay rows.

User clarification: permission requests and questions count as handoffs. Only ordering is stabilized; the tiny relative-time label and its full timestamp continue reporting tool/stream activity. Regression tests cover fresh raw activity under an older ordering key.

# Concise Chat Implementation Plan

**Goal:** Deliver the original Concise chat mode as a dependent feature on Timeline PR49.

**Architecture:** Reuse the virtual MessageList with a pure concise row projection and controlled per-block clamping. Use a shared protocol task-notification parser for history and existing ChatTask live metadata; no new RPC. Add the third saved view mode through existing settings.

**Spec:** docs/superpowers/specs/2026-11-23-concise-chat.md

- [x] Project visible messages and terminal task summaries, deduplicating live/history notifications and excluding background launch acknowledgements; prove with pure tests.
- [x] Add remembered Concise toggle, isolated list memory, composer/request continuity and full-view task navigation; test integration.
- [x] Add bounded, expandable content blocks and compact completed-task rendering in MessageList; preserve virtualization and auto-scroll.
- [x] Verify old/live chats, pagination, queued messages, warnings, requests, expansion and tab/view restoration. Run affected suites, browser checks and independent review; open dependent PR.

**Interfaces:** buildConciseRows(items,tasks,hasMore=false) returns Row or taskSummary rows. Task summaries carry id,description,status(completed/failed/stopped/unknown),summary,optional model/tokens/durationMs. All rows retain itemIds for navigation/anchors. MessageList gets optional concise=false; ChatState gets conciseView and ListMemory gets optional expanded:Set<string>. Concise uses separate keyed MessageList instance and existing composer stays mounted.

Verification: full protocol (180), desktop (1,292) and service (1,688) suites; all 13 performance tests; workspace typecheck/lint; desktop Concise, live tasks/permissions, Timeline and phone browser checks. An additional task-only scroll-anchor regression passed with all 40 affected message/scroll tests. Desktop and phone screenshots inspected. Independent review found no remaining blockers.

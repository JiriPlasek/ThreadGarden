# Chat Timeline Implementation Plan

**Goal:** Inspect a long chat as calendar blocks for turns and delegated agents, without loading the entire transcript into the UI.

**Design:** The user chose calendar blocks with a proportional vertical time axis, folded idle gaps, separate agent lanes, and a detail panel. A workflow is an ordinary chat, not a new runner. The existing conversation stays available. This change adds Timeline only, not the separately discussed Concise mode.

**Architecture:** Project the service's existing complete history/live view into lightweight timeline blocks. Keep time and task interpretation in the service; layout and lane allocation belong to the desktop. Reuse normalized chat items for inspection. Read Claude history only through SDK methods; never infer missing dates from the current clock. Reuse the timestamps branch's Codex result correction.

**Constraints:** No new dependencies. Unknown timing is never invented; undated entries are hidden from Timeline as requested in review. Live work must not disappear on a refresh. Detail requests validate block membership in the requested chat. Permission requests remain answerable through the existing composer.

- [x] Add timeline schemas and a pure projection with tests for turns, parallel agents, unknown times, background completion, and live work.
- [x] Preserve tool start/end timestamps in normalization; expose timeline summaries and bounded detail reads through chat handlers. Test history spanning more than one conversation page.
- [x] Add a remembered Conversation/Timeline selector, calendar layout with zoom and idle folding, keyboard-accessible blocks, and an inspector using existing message rendering.
- [x] Verify projection, handlers, UI interactions, typecheck, formatting, and the runnable local app. Keep the prior combined review branch intact.

Review found that an open inspector needed to refresh its messages as well as its block summary. It now reloads its selected pages with stale-response protection. The browser test inspects a turn while it runs and verifies its final report appears without reopening it. Historical Agent results whose SDK wrapper omits structured output use the explicit resume trailer to identify the subagent; its messages are still read only through the SDK.

Visual review: every block now has a minimum labeled height. A shared piecewise axis expands short recorded intervals across all lanes, rather than covering the next entry or gap with an oversized card. The zoom tooltip discloses this; the timestamps and reported durations remain original. Clock ticks align to conventional local clock intervals, prompt starts show their timestamp, and gaps are retained across the entire history returned by the SDK. Goal lifetimes are not reconstructed from incomplete lifecycle data. The redundant Timeline summary bar is removed; compact navigation controls float in the corner.

The view selector is a joined Conversation/Timeline button group on the second header row, with direct access on phones too. Segment subtitles show reported token totals and duration instead of completion labels. Turn totals include reported cached input; agent totals come from task usage or known SDK result metadata/trailers. Missing usage remains absent.

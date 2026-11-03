# Move a chat: spike results

Date: 2026-11-03. This covers the spike from `docs/superpowers/plans/2026-11-02-move-chat-spike.md`, which checks §5 of [the move-chat design](2026-11-02-move-chat-design.md).

## The test

**Tool:** the throwaway spike in `spikes/move-session/` (deleted once the move was built; it is in the git history), run with SDK 0.3.314 and Claude Code 2.1.314. It uses only the official API: `importSessionToStore`, `query({ resume, sessionStore, cwd })`, `listSessions` and `getSessionMessages`, the last two with and without the store.

**The test chat:** made on This PC in `C:\tmp\tg-move-spike`, session `2230e968-…`. It read `README.md`, sent a subagent to list the folder, and was told to remember `ORNN-FORGE`. Its export holds the main transcript (55 entries) and the subagent's own (26 entries).

## Results per check

| Check (spec §5) | Result | Evidence |
|---|---|---|
| A Windows chat resumes on Linux, in a different folder | **pass** | On kumbal-machine, in `~/threadgarden/projects/tg-move-spike`, Claude named ORNN-FORGE and the subagent's files. A second resume quoted the first resumed turn. |
| Which `projectKey` the store must answer | **recorded** | The SDK asks for the *target* folder's key (`-home-kumbal-machine-threadgarden-projects-tg-move-spike`; on This PC `C--tmp-tg-move-spike-b`). A store keyed by session ID and subpath answers any key. |
| Subagent transcripts come along | **pass** | `listSubkeys` was called on every resume, and `subagents/agent-a77f16a12e91bd53c` (26 entries) was loaded each time. |
| The session keeps its ID | **pass** | `2230e968-…` throughout, on both machines and on the way back. No re-keying is needed. |
| The resumed session appears in `listSessions` on the target | **only through the store** (see the finding) | Local `listSessions(target folder)` = 0. With `sessionStore`: 1 session, with the new turns (13 messages on Linux). |
| The round trip, This PC → Ubuntu PC → This PC, into the original folder | **pass** | Claude named ORNN-FORGE and quoted the question asked on the Ubuntu PC. There was no clash: the old local transcript stayed untouched (8 messages), and the store holds the whole chat (16 messages). |
| The history renders in Threadgarden | **moved to the build** | The service reads history only through the SDK's `listSessions` and `getSessionMessages` (`sdk/real-adapter.ts`). Both accept `sessionStore` and return the same `SessionMessage` shape, so it is checked in the build. |

## The finding that changes the design

**A chat resumed from a store never lands in the target's own Claude history.** For a resume from a store, the SDK runs Claude Code with `CLAUDE_CONFIG_DIR` set to a temporary `os.tmpdir()/claude-resume-<uuid>` (seen in `sdk.mjs`). It puts the transcript there and deletes the folder afterwards, so new entries reach only `store.append()`.

§5's "Claude Code writes its own transcript on the target as usual" is therefore false. The SDK's intended model works instead, and the spike proved it: **Threadgarden's store is the moved chat's home on the target.**
- Every later turn resumes with `sessionStore`.
- Reading goes through `listSessions` and `getSessionMessages` with that store.
- Appends are deduplicated by `uuid`.

What follows from that:
- A moved chat lives in Threadgarden's own data on the target, never under `~/.claude`, which keeps the hard rule.
- `claude --resume` in a terminal on the target does not see it.
- Threadgarden must index store-backed chats beside the history it watches today. The `~/.claude/projects` watcher does not see them.
- On a return, the store copy replaces the stale local copy with the same ID: one chat (§6).
- The old copy on the source is still Claude Code's untouched local transcript, so "read-only and hidden" means Threadgarden hides it and shows its store copy instead.

## The path for the build

**Full history** (spec §5's must-pass passed), with no stated gaps:
- subagents come along;
- the ID is kept;
- the round trip is clean.

The build plan follows from the design plus the finding above: a persistent, Threadgarden-owned session store per machine, used for every turn and every read of a moved chat.

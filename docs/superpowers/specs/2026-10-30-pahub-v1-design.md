# pahub v1 — Design

**Date:** 2026-10-30
**Status:** Approved by owner for implementation
**Scope:** First release (v1). Later work is listed under [Beyond v1](#beyond-v1) so v1 decisions don't block it.

---

## 1. Intent

pahub is a cross-platform desktop app that replaces the Claude Code terminal UI as the place where one developer runs, watches, and returns to all of their Claude Code work on one machine.

### The problem it solves

The owner runs many Claude Code sessions at once across several projects (a large work monorepo pair, a hobby SvelteKit + Rust project, assorted personal repos), mostly from terminals and from Neovim via `claude-code.nvim`. The recurring pain:

1. **Finding previous conversations.** The `/resume` picker is per-project by default and slow to scan.
2. **Forgotten running agents.** A session sits waiting on a permission prompt in some terminal nobody is looking at.
3. **Terminal sprawl.** Every session is its own terminal window; there is no single place that shows everything.

### What success looks like

The owner stops opening `claude` in a terminal for everyday work, because pahub does the same job faster and shows everything in one window.

### Audience

The owner first. The project may be shared with coworkers and may become public, so it is built to public-project standards from day one: clean history, real README, documented setup, no personal paths or secrets in the repo, cross-platform from the first commit.

---

## 2. Goals, non-goals, anti-goals

### Goals (v1)

- **Projects:** chats grouped by project, the project list discovered automatically from where Claude Code has been used.
- **History:** every past Claude Code conversation on the machine is browsable, readable, searchable (full text), and resumable in one click.
- **Live sessions:** every chat pahub runs shows live status; chats that need the user are impossible to miss.
- **Running agents overview:** every running session — pahub's own, plus sessions running elsewhere on the machine (terminal, Neovim, `claude --bg`) — and the subagents inside pahub's sessions.
- **Full chat:** a chat experience good enough that the owner never needs the terminal for normal work (detailed in §6.4).

### Non-goals (v1)

- Agent teams (see [Beyond v1](#beyond-v1)).
- Side-by-side split panes (v1 has tabs; split comes in v1.1).
- Neovim → pahub "add this file" bridge.
- Driving sessions that are running in other processes (pahub shows them and hands off; it does not type into them).
- Editing Claude Code settings, skills, agents, hooks, or MCP configuration from pahub.
- Multi-machine or cloud sessions.

### Anti-goals (failure even if every feature works)

These are hard requirements and outrank features. When a feature conflicts with one of these, the feature loses.

1. **Slow.** pahub must feel at least as fast as the terminal. Sluggishness is the single biggest failure mode. See the budgets in §8.
2. **Damaging Claude Code's data.** pahub never writes, rewrites, renames, moves, or deletes anything under `~/.claude/` (or `CLAUDE_CONFIG_DIR`) by its own hand. The only writes that happen there are the ones Claude Code itself makes while running a session pahub started. Uninstalling pahub leaves Claude Code exactly as it was. Switching back to the terminal is always safe.
3. **Falling behind Claude Code.** pahub uses the user's installed Claude Code and only official, documented interfaces. New Claude Code features must not break pahub; unknown data must degrade to a generic rendering, never to a crash or a silently dropped message.
4. **Crashing or losing work.** Closing or crashing the window never stops running agents. A broken chat never takes down the app. Unsent drafts survive restarts.

Using the mouse is fine; full keyboard coverage is welcome but not a requirement.

---

## 3. Constraints and verified facts

These were checked against the Claude Code documentation (code.claude.com/docs) on 2026-10-30, against Claude Code v2.1.314.

- **Transcripts are an internal format.** They live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, but the docs state the entry format "is internal to Claude Code and changes between versions." **pahub must not parse transcript files.** It reads history only through the Agent SDK.
- **The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the official programmatic interface.** It exists for TypeScript and Python only. It spawns one `claude` subprocess per session and provides:
  - `query()` with streaming input; the returned `Query` exposes `interrupt()`, `setModel()`, `setPermissionMode()`, `supportedCommands()`, `supportedModels()`, `streamInput()`, `close()`, `rewindFiles()` and more.
  - Options including `cwd`, `resume`, `forkSession`, `model`, `effort`, `permissionMode`, `canUseTool`, `settingSources`, `includePartialMessages`, `systemPrompt` (with the `claude_code` preset), `pathToClaudeCodeExecutable`.
  - Session functions: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `forkSession()` (and `renameSession()`/`tagSession()`, which pahub does **not** use — see §5.3).
  - It bundles a native Claude Code binary pinned to the SDK version; `pathToClaudeCodeExecutable` points it at a separately installed `claude` instead.
- **Agent teams require an interactive terminal session.** With `-p` or the Agent SDK, teammates are never spawned. This is why teams are out of v1 and will need a real terminal pane later.
- **`claude agents --json`** is documented as "the supported way to read session state from outside Claude Code." It lists active sessions (interactive and background) with `cwd`, `kind`, `startedAt`, and, when present, `id`, `state` (`working|blocked|done|failed|stopped`), `pid`, `status` (`busy|waiting|idle`), `waitingFor` (`permission prompt|input needed|sandbox request|worker request|dialog open`), `sessionId`, `name`. `--all` adds completed sessions. Files under `~/.claude/jobs/` are explicitly not a stable interface and must not be read.
- **SDK-created sessions do not appear in the terminal's `/resume` picker** (they remain resumable with `claude --resume <session-id>`). pahub mitigates this with a "copy resume command" action.
- **Resuming one session in two processes interleaves both into one transcript.** pahub must never resume a session that is currently running elsewhere (policy in §4.4).
- **Authentication and terms.** The Agent SDK overview states: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" Its use is governed by Anthropic's Commercial Terms. pahub's auth stance is set in §5.5.
- **Branding.** The SDK's branding guidelines forbid presenting a product as "Claude Code" or mimicking Claude Code's visual identity. pahub keeps its own name and look; it may say it works with Claude Code.
- **Platforms:** Windows, macOS, and Linux from the first release. The owner can only test Windows by hand; macOS and Linux rely on CI.
- **Owner's environment:** Windows 11, Claude Code installed at `~/.local/bin/claude`, Rust 1.92, Node 22, pnpm 11.

---

## 4. Architecture

```
┌──────────────────────────── pahub desktop app (Tauri 2) ─────────────────────────────┐
│  Rust shell: window, tray icon, OS notifications, starts/locates the service,        │
│  single-instance, autostart-on-login (opt-in)                                        │
│                                                                                       │
│  UI: SvelteKit 5 (static, SPA) + Tailwind + shadcn-svelte, running in the OS webview │
│        │                                                                              │
└────────┼──────────────────────────────────────────────────────────────────────────────┘
         │ WebSocket on 127.0.0.1 (random port, per-install auth token)
         ▼
┌──────────────────────────── pahub service (TypeScript) ──────────────────────────────┐
│  Session host: one Agent SDK query() per live pahub chat                              │
│  History index: SQLite (FTS5) built from listSessions()/getSessionMessages()          │
│  Watchers: ~/.claude/projects (read-only, change detection only)                      │
│  External sessions: polls `claude agents --json --all`                                │
│  File index per project for @-mentions                                                │
│  pahub's own store: SQLite in pahub's data dir                                        │
└───────────────┬───────────────────────────────────────────────────────────────────────┘
                │ Agent SDK → spawns the user's installed `claude` (one process per chat)
                ▼
          Claude Code processes  →  write their own transcripts to ~/.claude/projects
```

### 4.1 Why this split

- **The service is TypeScript** because the Agent SDK — the only official way to drive Claude Code programmatically and read its history — exists only for TypeScript and Python. Re-implementing the SDK's stdio control protocol in Rust would depend on undocumented internals and violate anti-goal 3.
- **The service is a separate process from the app** so that agents survive the window closing and survive an app crash (anti-goal 4).
- **The UI talks to the service directly over a WebSocket**, not through Rust, so streaming tokens take one hop. The Rust shell handles only native concerns.
- **Rust's role** is the native shell: window, tray, notifications, single-instance, launching and supervising the service, and (beyond v1) the PTY for team-mode terminals.

### 4.2 Process lifecycle

- **Starting the app** checks for a running service via a discovery file in pahub's data dir (`service.json`: pid, port, token, version, startedAt). If none is alive, the app starts the service **detached**, so it does not die with the app. If one is alive but its version differs from the app's, the app shows "Restart the pahub service to update" (it never restarts automatically while agents run).
- **Closing the window** hides it to the tray. The app keeps running so it can show notifications.
- **Quitting the app** (tray → Quit) leaves the service and all agents running. On next launch the app reconnects and everything is as it was.
- **Stop all work** (Running folder and tray menu, with confirmation) interrupts and closes every live pahub session; the service keeps running.
- **Quit pahub completely** (tray menu, with confirmation listing running agents) stops all work, then stops the service, then exits the app.
- **Service idle exit:** with no live sessions and no connected client for 30 minutes, the service exits to free resources.
- **Service crash or reboot:** running agents end. Their conversations are already persisted by Claude Code; on next launch each such chat shows as "Interrupted — resume" and resumes in one click. The service records which sessions were live (in its own store) so this list is accurate.
- **Single instance:** a second app launch focuses the existing window.

### 4.3 Live-session lifecycle

A pahub chat is **live** while its Claude Code process exists. Processes cost memory, so they do not live forever:

- A chat becomes live when the user sends a message in it (new chat, or a history chat being continued).
- **End session** (per chat, in the chat header and the chat's context menu) closes the process. The chat returns to history-only status; the conversation is intact.
- **Idle reclaim:** a live chat that is idle (no turn in progress, nothing waiting on the user) for 15 minutes has its process closed automatically (configurable; 0 disables). Its status shows as idle-reclaimed ("○ paused") rather than plain history, and the next message transparently resumes it via SDK `resume` with the same session ID. A pinned chat is never reclaimed.
- A chat waiting on the user (permission, question, plan approval) is never reclaimed.
- Closing a tab never ends a session.

### 4.4 Resume safety

Continuing one Claude Code session from two processes interleaves both into one transcript, so pahub refuses to resume a session it believes is running elsewhere:

- **Blocked** when `claude agents --json --all` lists the session (matched by `sessionId`) with a live `pid`, or with `state` `working` or `blocked`. The UI explains why and offers the hand-off actions from §6.3.
- **Allowed** when the session is listed only as `done`/`failed`/`stopped` without a live `pid`, or not listed at all.
- **Cannot verify** (the `claude agents` command is missing, fails, or agent view is disabled): pahub allows the resume after a confirmation that says it can't check whether the session is open elsewhere. It additionally warns if the transcript's file modification time is within the last 2 minutes.
- pahub's own live sessions also appear in `claude agents` output; pahub recognises them by session ID and never treats them as external.

The builder confirms empirically which `state`/`status` values a running interactive session reports and adjusts the matching, keeping the "block when in doubt about a live process" bias.

### 4.5 Service ↔ UI protocol

- WebSocket on `127.0.0.1`, random free port, bearer token generated per install and stored in `service.json` with user-only file permissions. Connections without the token are rejected. The service never binds a non-loopback address.
- Messages are JSON, typed by a shared TypeScript package (`protocol`) used by both service and UI, validated at the boundary (e.g. with zod) in development builds and on the service side always.
- Shape: request/response (`id`, `method`, `params` → `result | error`) plus server-pushed events (`event`, `data`). Events carry a per-session monotonically increasing sequence number so a reconnecting UI can ask for "everything after N" and never misses or duplicates output.
- The protocol is versioned; the app refuses to talk to an incompatible service version and offers the restart above.

---

## 5. Data

### 5.1 What pahub reads (never writes)

| Source | How | Used for |
|---|---|---|
| Session list and metadata | SDK `listSessions()`, `getSessionInfo()` | History, projects, titles, branch, timestamps |
| Session contents | SDK `getSessionMessages()` | Reading old chats, search index |
| Change detection | File-system watch on `~/.claude/projects/` (names, mtimes, sizes only — file contents are never opened by pahub) | Knowing when to re-query the SDK |
| Live external sessions | `claude agents --json --all` | Running-agents overview |
| Claude Code settings, CLAUDE.md, skills, hooks, MCP | Loaded by Claude Code itself via SDK `settingSources: ["user", "project", "local"]` | Behaviour identical to the CLI |

If `CLAUDE_CONFIG_DIR` is set in the environment pahub was started from, pahub honours it everywhere it resolves `~/.claude`.

### 5.2 What pahub stores (its own data dir only)

Location: the OS-standard app data dir (`%APPDATA%\pahub`, `~/Library/Application Support/pahub`, `$XDG_DATA_HOME/pahub`).

- `pahub.db` (SQLite):
  - search index (FTS5) of message text per session, with the session's `lastModified`/`fileSize` at indexing time for incremental refresh;
  - pahub-side metadata: custom titles, pinned chats, hidden/pinned projects, tab layout;
  - draft text per chat (saved as you type, debounced);
  - the set of sessions that were live, for crash recovery;
  - per-chat UI state (scroll position, collapsed tool calls).
- `service.json` (discovery, see §4.2), `logs/` (rotating, no message content at info level).

Deleting this directory resets pahub completely and touches nothing of Claude Code's.

### 5.3 Titles

Display title priority: pahub custom title → Claude Code's session name / generated title / summary (as returned by the SDK) → first prompt (truncated). Renaming in pahub stores a pahub-side title only; pahub does **not** call `renameSession()`/`tagSession()`, because those write to Claude Code's data (anti-goal 2).

### 5.4 Projects

A project is a working directory that has sessions (the SDK reports each session's `cwd`). Projects are grouped by real path; git worktrees of the same repository are grouped under the repository (the SDK's worktree info, or `git` metadata read-only, decides). Display name: the directory's basename, disambiguated with the parent when two collide. Projects can be pinned (top of list) or hidden.

A new chat can be started in any listed project or in any folder chosen with a native folder picker.

### 5.5 Authentication (owner decision)

- **By default pahub never handles credentials.** Sessions inherit whatever authentication the user's installed Claude Code already uses (subscription login or API key). pahub has no login screen of its own.
- **Optional API key:** pahub's settings accept an Anthropic API key. When set, pahub passes it to every session it starts (as `ANTHROPIC_API_KEY` in the session environment, keeping the rest of the inherited environment), so those sessions run on the API key instead. The builder verifies that the CLI prefers the key over a stored subscription login in SDK mode and documents the result.
- The key is stored in the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service on Linux), never in `pahub.db`, `service.json`, or logs. Removing it reverts to inheriting.
- The status bar shows which authentication the active session uses (from the SDK's account info), so the user always knows whether a chat runs on a subscription or on API billing.
- **Before pahub is shared beyond the owner or published**, its use of subscription auth is reviewed against Anthropic's terms; pahub must be able to ship in an API-key-only configuration (a build/config flag that hides the inherit option) without code changes elsewhere. The README states that users are responsible for complying with Anthropic's terms for the authentication they use.

---

## 6. User experience

### 6.1 Main window (layout "C" with smart folders)

Three columns plus a status strip:

1. **Left column — places.**
   - Smart folders with count badges: **◐ Needs you**, **● Running**, **All chats**.
   - Projects (pinned first, then by recent activity).
   - "Needs you" and "Running" list matching chats **across all projects**, including external sessions.
2. **Middle column — chat list** for the selected place.
   - Search box at the top (filters this list; full-text).
   - Each row: status icon, title, project (when the place spans projects), one-line preview — the last message, or what it waits for ("permission: Bash(npm test) · 4m"), relative time.
   - External sessions are marked as such (e.g. a small "terminal" glyph).
   - Sorted: needs-you, then running, then by last activity.
3. **Right column — the open chat**, with **tabs** across the top for every open chat (v1). Middle-click / Ctrl+W closes a tab; closing a tab never stops a session.
4. **Bottom strip — every running agent**, from every project, needs-you first. Clicking one jumps to it. A "Stop all work" control lives here behind a confirmation.

**Ctrl/Cmd+K quick switcher:** fuzzy search over chat titles, projects, and full text; Enter opens the chat (or focuses its tab). Also hosts commands such as "New chat in…", "Stop all work".

Column widths are resizable and remembered; the first two columns can be collapsed.

### 6.2 Status model

| Icon | Meaning | pahub chat | External session |
|---|---|---|---|
| ◐ (amber) | Needs you: permission prompt, question, plan approval | pending `canUseTool` / AskUserQuestion / ExitPlanMode | `status: waiting` or `state: blocked` |
| ● (green, animated) | Working | query streaming / tool running | `status: busy` or `state: working` |
| ○ (dim) | Idle — finished its turn, alive | live query, no turn in progress | `status: idle`, or `state: done` with a live `pid` |
| ○ paused | Idle-reclaimed (§4.3) — no process, next message resumes | process closed by idle reclaim | — |
| ✕ (red) | Failed / interrupted | process exited with error, or service restarted under it | `state: failed` |
| (none) | History only | not live | not in `claude agents` |

Any status pahub doesn't recognise renders as a neutral "unknown" icon with the raw value in a tooltip.

**Notifications:** when a chat enters "Needs you" and the pahub window is not focused on that chat, the app posts an OS notification (title, project, what it wants). Clicking it opens the chat. Notifications can be turned off in pahub's settings. The tray icon shows a badge while anything needs the user.

### 6.3 External sessions

Sessions running in other processes (terminal, Neovim, `claude --bg`) come from `claude agents --json --all`, polled about every 2 s while the window is visible and every 10 s otherwise. If the command is missing, fails, or agent view is disabled, the feature hides itself and shows a one-line explanation in settings; nothing else is affected.

For an external session, pahub offers:
- open its history read-only (when `sessionId` is present);
- **copy** `claude attach <id>` (background sessions) or `claude --resume <sessionId>`;
- **Continue in pahub** — only when the session is not running anywhere (otherwise disabled with an explanation, see §4.4).

### 6.4 The chat (v1 "full chat")

The chat is rendered by pahub from SDK messages.

**Rendering**
- Markdown with syntax-highlighted code blocks, tables, images.
- Tool calls collapsed into compact rows ("Read 12 files", "Bash · npm test · exit 0") that expand to full input/output.
- File edits rendered as diffs (unified by default, side-by-side toggle).
- Subagent activity grouped under the tool call that started it, with its own live status; subagents also appear under their parent chat in the Running views.
- Todo lists (the TodoWrite tool) rendered as a checklist.
- Thinking blocks collapsed by default.
- Context usage, model, and session cost/tokens shown in the chat header.
- **Unknown message or content types render as a generic, collapsible "unrecognised item" with the raw JSON**, never dropped (anti-goal 3).

**Input**
- Multi-line composer; Enter sends, Shift+Enter newline (configurable).
- **Typing while Claude works queues the message**, matching the CLI.
- **`@` mentions:** typing `@` opens a fuzzy file/folder picker over the chat's project (respecting `.gitignore`); the selection becomes a tag. Drag-and-drop or pasting a file path creates a tag too. How tags are passed to Claude must match the CLI's `@path` behaviour as closely as the SDK allows; the builder verifies what the SDK does with `@path` text and documents the result.
- **Slash commands:** typing `/` opens autocomplete from `supportedCommands()` (kept current via the commands-changed message); commands are sent the way the SDK documents. Commands that are terminal-UI-only in the CLI are mapped to pahub UI where a matching SDK control exists (model, permission mode, effort) and otherwise listed as unavailable rather than silently ignored.
- **Images:** paste or drop images into the composer; sent as image content.
- **Stop / interrupt:** a Stop button and Esc while the chat is focused call `interrupt()`.

**Controls**
- Model picker (from `supportedModels()`), effort, and permission mode (default / acceptEdits / plan / auto where available / bypass) in the chat header; changes apply live where the SDK supports it.
- **Permission prompts** appear inline as a card with the tool, its input (diff for edits, command for Bash), and buttons: **Allow**, **Always allow** (offering the SDK's suggested rule), **Deny** (with optional reason). The same card appears in the "Needs you" list preview.
- **Questions (AskUserQuestion)** render as a form with the offered options plus free text.
- **Plan approval (ExitPlanMode)** renders the plan with Approve / Keep planning.
- **Resume** any history chat; **Fork** a chat from any user message (SDK `forkSession` with `upToMessageId`, which creates a new session and leaves the original untouched).
- **Copy resume command** for every chat.

**Sessions started by pahub**
- Run with the user's Claude Code configuration: `settingSources: ["user","project","local"]`, `systemPrompt: { type: "preset", preset: "claude_code" }`, `cwd` = the project directory, so behaviour (CLAUDE.md, skills, hooks, permissions, MCP) matches the CLI.
- Use the user's installed `claude` via `pathToClaudeCodeExecutable` (resolved from PATH and standard install locations; overridable in settings). If none is found, or a session fails to start because the CLI is too old (`cli_version_too_old`), pahub shows a setup screen explaining how to install or update Claude Code. There is no fallback to the SDK's bundled binary: it is large, would have to ship per platform, and would drift from the user's own install. The Claude Code version from the session's init message is shown in the status bar. Other documented startup-failure reasons from the SDK (e.g. `session_held_by_background`, `cwd_unavailable`) are shown to the user with their meaning.

### 6.5 Settings (pahub's own)

Claude executable path, optional API key (§5.5), idle-reclaim minutes, notifications on/off, Enter-to-send behaviour, theme (system/light/dark), start on login (off by default), external-session polling on/off. Stored in `pahub.db` (the API key excepted).

---

## 7. Robustness

- Every chat's SDK query runs inside its own error boundary in the service; one chat failing (process crash, protocol error) marks only that chat failed.
- The UI renders each chat in an error boundary; a rendering bug shows a "this message couldn't be displayed — show raw" fallback rather than a blank app.
- The UI reconnects to the service automatically with backoff and resynchronises by sequence number (§4.5).
- Drafts are persisted on every change (debounced ≤ 300 ms).
- The service never holds unflushed state that matters across a crash except the in-flight turn, which Claude Code persists itself.
- Logs are rotating files in pahub's data dir; debug logging that includes message content is opt-in.

---

## 8. Performance budgets

These are acceptance criteria, measured on the owner's Windows machine with a realistic corpus (≥ 1,000 sessions, ≥ 50 projects, at least one session with ≥ 2,000 messages). Where possible they are also enforced by automated tests against a synthetic corpus of the same size.

| What | Budget |
|---|---|
| App launch to window with last-known chat list visible (service already running) | ≤ 800 ms |
| App launch with service cold start | ≤ 2 s to usable list |
| Switching to an already-open tab | ≤ 50 ms to first paint |
| Opening a history chat (cached index) | ≤ 150 ms to first screenful |
| Keystroke to character on screen in the composer | ≤ 16 ms (no dropped frames) |
| Ctrl+K results update per keystroke | ≤ 50 ms |
| Full-text search across the corpus | ≤ 150 ms |
| Streaming output | renders without visible stutter at full model speed; long chats virtualised |
| Initial indexing of an existing corpus | runs in the background, never blocks the UI; incremental refresh after that |
| Service idle memory (excluding Claude processes) | ≤ 150 MB |

Techniques the design expects (the builder may choose others that meet the budgets): virtualised lists and message views, the SQLite index as the source for lists and search (the SDK is queried only for changed sessions), incremental indexing keyed on `lastModified`/`fileSize`, batched UI updates during streaming, no synchronous IPC on the UI thread.

---

## 9. Quality and project standards

- **Repository:** public-grade from day one. Conventional commits, a README that explains what pahub is, how to install it, and how to develop it; CONTRIBUTING notes; no personal paths, tokens, or machine details committed.
- **Layout (proposal, builder may refine):** pnpm workspace with `apps/desktop` (Tauri 2 + SvelteKit UI), `packages/service` (TypeScript service), `packages/protocol` (shared types and schemas).
- **CI (GitHub Actions) on Windows, macOS and Linux for every pull request:** formatting, lint, type-check, unit tests for service/protocol/UI, Rust `fmt`/`clippy`/tests, and a full Tauri build. A failure on any OS blocks merge.
- **Tests:**
  - Service logic is tested against a fake SDK adapter (the service accesses the SDK only through a thin adapter interface so it can be faked), covering session lifecycle, permission flow, crash recovery, sequencing/resync, indexing.
  - Read-only guarantee: a test runs the service against a fixture `CLAUDE_CONFIG_DIR` and asserts that no file under it is created, modified, or deleted by pahub's own code paths.
  - Forward-compatibility: unknown message/content types and unknown `claude agents` fields/values render as generic items, covered by tests.
  - UI components tested with a mock service; performance budgets with a synthetic corpus where automatable.
  - A small opt-in integration suite runs against the real `claude` (requires a logged-in Claude Code; not run in CI).
- **Packaging:** installers per OS from the Tauri bundler. The service is bundled into a single JavaScript file and runs on a Node.js runtime shipped inside the app as a Tauri sidecar (downloaded from nodejs.org at build time and checksum-verified), so users need no Node installation. Code signing is out of scope for v1.
- **Dependencies:** the Agent SDK is kept current (automated update PRs); its changelog is reviewed before minor bumps.

---

## 10. Beyond v1

Recorded so v1 leaves room for them; not built in v1.

- **v1.1 Split view:** side-by-side panes in the chat column.
- **Team mode:** a chat explicitly opened in team mode runs the real interactive `claude` in an embedded terminal pane (PTY in the Rust shell or service, xterm.js in the UI), with agent teams enabled for that session only. Next to it, a read-only dashboard renders the team's task list and teammate messages from `~/.claude/tasks/<team>/` and `~/.claude/teams/<team>/`. These files are read-only to pahub and are undocumented formats, so the dashboard degrades gracefully when they change.
- **pahub-native teams:** pahub coordinates several SDK sessions on different models through tools pahub exposes (message a peer, claim a task), with review gates pahub enforces.
- **Neovim bridge:** `<leader>ab`-style "add this file/selection to the focused pahub chat", either by pahub sessions connecting to `claude-code.nvim`'s IDE server (needs verification that SDK sessions support IDE connections) or via a pahub endpoint plus a small Neovim command.
- **Rewind/checkpoints UI** (`rewindFiles`), cost dashboards, cross-chat analytics.

---

## 11. Decisions log

Decided by the owner:
- Desktop app, not a browser page; Tauri with a SvelteKit UI.
- Custom chat view by default; agent teams only via an explicit terminal-based team mode, later.
- Layout C (places → chat list → chat) with "Needs you" / "Running" smart folders and a bottom running-agents strip.
- Tabs (and later split) for open chats.
- Agents keep running when the window closes; explicit "Stop all work".
- Windows, macOS, Linux from the start.
- v1 scope: projects, history, live sessions, running-agents overview, full chat, `@` file tagging by name.
- Anti-goals: slowness, damaging Claude data, falling behind Claude Code, crashes/lost work.
- Authentication: inherit the installed Claude Code's auth, with an optional API key; terms review before sharing or publishing (§5.5).

Decided by the designer (owner may revisit):
- Service in TypeScript on the Agent SDK; history read only via the SDK; transcript files never parsed.
- UI ↔ service over a loopback WebSocket with a token; Rust shell for native concerns only.
- External sessions via `claude agents --json`, read-only with hand-off actions.
- pahub-side titles instead of `renameSession()`.
- Close-to-tray; service idle exit after 30 minutes with nothing live.
- Per-chat "End session" plus 15-minute idle reclaim with transparent resume (§4.3).
- Resume-safety policy biased toward blocking when a live process might exist (§4.4).
- API key kept in the OS credential store.
- Use the installed `claude` only; a setup screen when it is missing or too old (no bundled-binary fallback).
- Service runtime: bundled JS on a shipped Node.js sidecar; storage via Node's built-in `node:sqlite` (no native addons).
- Tabs in v1, split in v1.1.
- Performance budgets in §8.

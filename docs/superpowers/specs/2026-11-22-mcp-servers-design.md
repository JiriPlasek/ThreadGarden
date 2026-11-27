# MCP servers in the chat

Approved by the owner on 2026-11-22. Piece 1 of two; piece 2 is `!` commands (a real terminal in the chat,
whose output Claude sees), designed separately afterwards.

## Why

A chat on wobble stopped because the project's own MCP server (`etoro`, from the project's `.mcp.json`) never
loaded. Claude's advice was to SSH in, start `claude` by hand in the folder, accept the trust prompt, approve the
server and run `/mcp` → Reconnect (or clear its sign-in and reconnect). All of that lives only in the terminal CLI's
screens; a Threadgarden chat runs through the Agent SDK, which never shows them, and Threadgarden shows nothing about
MCP at all. The owner wants to stop SSH-ing into a machine for things only the CLI can do. This piece covers MCP:
everything in those four steps, done from the chat, on any machine.

## Goals

- See a chat's MCP servers: name, where each came from (project, user, local, plugin, claude.ai, …) and status
  (connected, waiting for approval, needs sign-in, failed with its error, off).
- Act on them from the chat: **Approve** a project server, **Sign in**, **Reconnect**, **Turn off / on**,
  **Forget sign-in**.
- Notice a project server waiting for approval without looking for it: a banner in the chat. Claude can't see an
  unapproved server, so it can't tell you about it; everything else it can.
- Works the same for a chat on this PC, on a paired machine (wobble) and on the phone.

## Non-goals

- Adding, editing or removing MCP server definitions (`claude mcp add`, editing `.mcp.json`). Threadgarden reads
  and approves; it doesn't author configs.
- MCP for Codex chats. The dialog and banner are for Claude chats only; Codex chats show neither.
- A machine-wide or project-wide MCP page outside a chat. Status comes from a live session.
- Approving into the committed `.claude/settings.json`.
- Pointing out servers that need sign-in, or that failed. The owner's rule: if a chat needs one, Claude says so,
  and the user opens the dialog and fixes it. (The owner's account has ~25 claude.ai connectors at "needs sign-in";
  surfacing them would put noise on every chat.)
- A "Needs you" state, notification or phone alert for MCP. `needsYou` means a turn waits on a permission and
  queues sends; MCP doesn't use it.

## Anti-goals

- Never write to the Claude config dir or a project's files beyond the approval entries in the project's
  `.claude/settings.local.json` (`enabledMcpjsonServers`, and `disabledMcpjsonServers` when approving a server that
  was rejected before), written the way the CLI writes them (merge, keep everything else in the file).
- Never store or log an OAuth token, auth code or callback URL. Claude Code keeps the credentials; Threadgarden only
  carries the URL through.
- No approval without a click. A project server is never approved automatically.

## Approaches

- **A) Through the live session's SDK controls (chosen).** `mcpServerStatus`, `reconnectMcpServer`,
  `toggleMcpServer` (declared in SDK 0.3.314), plus `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl` and
  `mcpClearAuth` (present in the SDK and handled by Claude Code 2.1.318 in SDK mode, but not declared in the SDK's
  types). Approval is a write to the project's `settings.local.json`. Reuses the session we already run.
- B) Run the real `claude` in a terminal for `/mcp`. Covered by piece 2 as an escape hatch, but a terminal UI inside
  a chat is a poor way to do four clicks, and its result isn't visible to the rest of Threadgarden.
- C) Read and write Claude Code's MCP files directly (`~/.claude.json`, credentials). Undocumented formats, writes to
  the config dir (breaks the read-only rule), and no live status.

## Decided

**Where it shows.**

```
┌ etoro_analysis · wobble ─────────────────────────────┐
│ ⚠ MCP server "etoro" (from this project) isn't       │
│   approved yet.             [Approve]  [MCP servers…] │
│ ...chat...                                            │
└───────────────────────────────────────────────────────┘

MCP servers (this chat)
  etoro        project   Needs sign-in   [Sign in] [⋯]
  github       user      Connected                [⋯]
  context7     plugin    Failed: timeout [Reconnect]
                         ⋯ = Reconnect · Turn off · Forget sign-in
```

- **Banner** in the chat only for project servers waiting for approval (decided by the owner), with **Approve** and
  **MCP servers…**. One banner per chat, naming the first such server and "and N more" when there are more. It can
  be dismissed for the session. Nothing else raises a banner: not needs sign-in, not failed, from any source.
- **MCP servers dialog**, opened from the chat header's menu or by sending `/mcp` in the message box (the CLI habit;
  `/mcp` is intercepted, never sent to Claude). It lists every server with its source and status and the actions
  that apply to it, including servers that need sign-in or failed: this is where the user goes when Claude says a
  server isn't working. Statuses refresh while the dialog is open.
- **A chat with no live process** (paused, interrupted, opened from history): there is no session to ask, so the
  dialog says so and offers **Wake the chat**, which resumes the session without sending a message (through the
  same resume-safety check as sending). It never wakes a chat by itself, and the banner can only show once a
  session is live.
- **Approve** adds the server's name to `enabledMcpjsonServers` in `<project>/.claude/settings.local.json` on the
  chat's machine (creating the file and folder if needed) and, if it's in `disabledMcpjsonServers` (rejected earlier
  in the CLI), takes it off that list: clicking Approve means the user wants it. Then it brings the server up:
  reconnect if Claude Code picks the approval up live, otherwise end and resume the session transparently between
  turns, the way an idle session is reclaimed and resumed. If that restart would stop running background tasks, the
  dialog asks: **Restart now** (naming how many tasks stop) or **When they finish**. Other live chats in the same
  project on that machine pick up the approval the same way, each between its turns.
- **Sign in** calls `mcpAuthenticate` and opens the returned link in the user's browser (desktop: the system
  browser; phone: the phone's). On the chat's own machine the sign-in finishes by itself through Claude Code's local
  callback. For a remote machine the browser lands on a page that can't load (`localhost` on the wrong computer);
  the dialog then shows a field: "Paste the address from your browser's address bar", sent with
  `mcpSubmitOAuthCallbackUrl`. Errors Claude Code returns (wrong attempt, missing code) are shown as it words them.
  A claude.ai connector is signed in on claude.ai, not through Claude Code: its Sign in is a link to claude.ai's
  connector settings.
- **Reconnect**, **Turn off / on** and **Forget sign-in** map to `reconnectMcpServer`, `toggleMcpServer` and
  `mcpClearAuth`. Claude Code does any saving, not Threadgarden; the labels say honestly how far it reaches (for
  example "Turn off in this project" if Claude Code saves the toggle per project; Forget sign-in is for the whole
  machine).
- **Protocol 12**, with an `mcp` capability. A paired machine on an older protocol stays accepted as
  `REMOTE_PROTOCOL_RANGE` allows today, but lacks the capability, so its chats show neither the banner nor the dialog. The undeclared SDK methods get one typed
  wrapper in `real-adapter.ts`, next to `interrupt({cancelQueued})` and `cancelAsyncMessage`, with the same note:
  recheck on every SDK update. The mock adapter gets fake servers in every state so the UI and e2e can be tested
  without a real MCP server.

## Left to the builder

Check these on the real CLI first (a throwaway project with a `.mcp.json` server, and one HTTP server that needs
OAuth), then build to what they show:

- How a project server that isn't approved shows up in `mcpServerStatus` (a status, `disabled`, or absent). If it's
  absent, the service reads the project's `.mcp.json` names and compares them with the approved list to find the
  waiting ones.
- Whether Claude Code reads `enabledMcpjsonServers` live (then reconnect is enough) or only at session start
  (then the transparent end-and-resume).
- Whether the folder-trust prompt matters for SDK sessions at all. Expected: it doesn't, and nothing is built for it.
- What `mcpAuthenticate` returns (the link, whether it says a callback is expected) and whether passing a
  `redirectUri` helps the remote case.
- When to refresh status: after each action, while the dialog is open, and on the SDK's `system/init` and any MCP
  status messages the session already receives.
- Whether `toggleMcpServer` is saved by Claude Code (and where), so the Turn off label is accurate.
- The wording of statuses, the banner and the paste field, in the app's plain style.

## After the spike (2026-11-22)

The spike (`2026-11-22-mcp-servers-spike-results.md`) found that in an SDK session a project server that was never
approved simply connects: there is no "waiting for approval" state. The only project server Claude can't see is one
**rejected earlier** in the CLI (`disabledMcpjsonServers`), which doesn't appear in the status list at all. Writing
the approval and reconnecting brings it up in the same process. So, by the controller's ruling while building:

- "Not approved" means named in the project's `.mcp.json` and missing from the status list; the banner shows for
  those (copy: `MCP server "‹name›" (from this project) isn't approved.`).
- **Approve** writes the lists (add to `enabledMcpjsonServers`, remove from `disabledMcpjsonServers`) and reconnects
  the server in this chat and in every other live chat in the folder. No restart, no "Restart now / When they
  finish" step.
- Claude Code saves **Turn off** per project in its own `~/.claude.json`, so the label is "Turn off in this project".
- No SDK message reports MCP status changes, so the dialog polls while it's open.

What failed in the original wobble chat is therefore not certain: a rejected server, a server that failed to start,
or one needing sign-in. The dialog covers all three.

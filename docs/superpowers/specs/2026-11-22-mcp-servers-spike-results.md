# MCP servers in the chat: spike results

Date: 2026-11-22. This covers the "Left to the builder" questions of [the MCP servers design](2026-11-22-mcp-servers-design.md).

## The test

**Tool:** `packages/service/test/real/mcp.real.test.ts` (opt-in; run it with `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real mcp.real`; a `--` before the filter is passed on literally and runs every real test instead). It is kept as the "recheck on every SDK update" check for the three undeclared `Query` methods. Run with SDK 0.3.314 and Claude Code 2.1.318, on This PC (Windows), with the owner's own login.

**Setup:** every check runs in a fresh temp folder that `claude` has never opened. It holds a `.mcp.json` naming `echo` (the stdio fixture `test/real/fixtures/echo-mcp-server.mjs`, started with `process.execPath`) and `oauthy` (`{ "type": "http", "url": "https://mcp.linear.app/mcp" }`: OAuth with dynamic client registration; no sign-in was ever completed). `RealAdapter.start` runs the session, no prompt is sent, and the `Query`'s methods are called directly (the adapter keeps the `Query` private, so the test reaches it with a cast). Secret-looking values (`code`, `state`, `client_id`, `code_challenge`, tokens) are redacted before printing. The owner's own servers are only counted, never named.

## Results per check

| Check | Result | Evidence |
|---|---|---|
| S1 unapproved project server | **Not hidden: it connects.** With no approval anywhere, `echo` was `connected` (`source: project`, `scope: project`, `config.type: stdio`, `serverInfo` and its tool listed), and `oauthy` was `needs-auth` (same source/scope, `config.type: http`). | `mcpServerStatus()` right after start, 3 runs. `system/init` did not arrive without a prompt (0 messages), so `init.mcp_servers` could not be read. |
| S2 approval picked up live | **Could not be tested as written** (nothing was waiting for approval). The rejected case is the testable one, see S7. After `enabledMcpjsonServers: ['echo']` was written mid-session, `echo` stayed `connected`; `reconnectMcpServer('echo')` returned `{}` and it stayed `connected`. | Resuming the session id failed with "No conversation found" (no prompt was sent, so there is no transcript); a brand-new process in the same folder showed `echo` `connected` too. |
| S3 folder trust | **Does not matter.** The server connected in a folder `claude` had never opened (`hasTrustDialogAccepted: false` in `~/.claude.json`). | S1, S2, S9. |
| S4 sign-in | **Works, see "AUTH_START".** | Raw results below. |
| S5 status messages | **None.** | Non-init messages seen during S2 and S4: `system/hook_started`, `system/hook_response`, `system/commands_changed`, and (S2 only, from the failed resume) `result/error_during_execution`. Nothing about MCP: a server's status change sends no SDK message. |
| S6 toggle | **Claude Code saves it, per project, in `~/.claude.json`.** | See "TOGGLE_SAVED_IN". |
| S7 rejected | **Absent.** A server named in `disabledMcpjsonServers` is missing from `mcpServerStatus()`. After moving it to `enabledMcpjsonServers` it is still absent until `reconnectMcpServer(name)`, which then brings it up (`connected`) in the same process. | 2 runs, same result. |
| S8 sources | See "SOURCE_VALUES". | |
| S9 (extra) | A folder whose `enabledMcpjsonServers` names only another server: `echo` `connected` anyway. Same with no approval anywhere and the `CLAUDE*` environment variables stripped (so the host Claude Code session is not what approves it). | |

## The finding that contradicts the design

**In an SDK session, a project server that was never approved or rejected is not waiting for approval: it simply connects.** The design's premise ("Claude can't see an unapproved server", a banner for servers waiting for approval, Approve as a write to `enabledMcpjsonServers`) holds in the terminal CLI, but in an SDK session the only thing that keeps a project server out is an explicit rejection: a name in `disabledMcpjsonServers`, which then shows as **absent** from `mcpServerStatus()` (the design expects absent for unapproved, and it is the rejected case instead).

What this means for the build, to be decided before Task 2:
- The banner case ("waiting for approval") has no state to show for a never-seen server. The remaining real case is a **rejected** server: absent from the status list while its name is in the project's `.mcp.json`. The service can find it by reading the project's `.mcp.json` names and comparing them with the status list (the design's fallback), but it cannot tell "rejected" from "defined in a `.mcp.json` Claude Code did not read" without also reading `disabledMcpjsonServers`.
- Approve, for a rejected server, is the design's path as written: take the name off `disabledMcpjsonServers`, add it to `enabledMcpjsonServers`, then `reconnectMcpServer(name)`. No end-and-resume is needed.
- The failure that started this work (the `etoro` server never loaded on kumbal) was therefore most likely a rejection (absent), a failed start, or needs-auth, not a missing approval. Worth checking on kumbal with the status list before building the banner's wording.
- Not tested: whether the approved/rejected lists in the project's `.claude/settings.json` or the user's `~/.claude/settings.json` are also honoured (only `settings.local.json` was tried; nothing under `~/.claude` was written).

## Constants for the build

- `UNAPPROVED_SHOWS_AS`: no waiting state exists in an SDK session. A never-approved project server shows `connected` / `needs-auth` / `failed` like any other, with `source: 'project'`, `scope: 'project'`. A **rejected** one (in `disabledMcpjsonServers`) shows `'absent'`.
- `APPROVAL_IS_LIVE`: `true`, for the rejected-to-approved case: after writing the lists, `reconnectMcpServer(name)` brings the server up in the same process (without the reconnect it stays absent). The write alone is not picked up.
- `APPROVALS_READ_FROM`: confirmed for the project's `.claude/settings.local.json` only (`disabledMcpjsonServers` honoured, `enabledMcpjsonServers` honoured through reconnect). Project `.claude/settings.json` and user `~/.claude/settings.json` were not exercised.
- `TOGGLE_SAVED_IN`: `'user'` file `~/.claude.json`, per project: `projects["<folder>"].disabledMcpServers: ["echo"]`. No settings file changed (`settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json` were unchanged). It persists: a fresh process in the same folder reports `echo` `disabled`. `toggleMcpServer('echo', true)` brings it up (`connected`) and rewrites that entry. So the label is "Turn off in this project".
- `AUTH_START`: `mcpAuthenticate(name)` resolves `{ authUrl, requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', state, callbackPort }`, where `authUrl` is `https://mcp.linear.app/authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A<callbackPort>%2Fcallback&state=…&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp` and `callbackPort` is Claude Code's local listener. `mcpAuthenticate(name, 'http://localhost:1/cb')` returns the same shape with `redirect_uri` set to that value, `redirectScheme: 'custom'` and **no** `callbackPort` (no local listener): the link's callback lands wherever the caller said, and the user pastes it back. Passing a `redirectUri` therefore changes both the link and the listener. No "already signed in" shape was seen (the server was never signed in). `status` stays `needs-auth` afterwards, and `mcpClearAuth(name)` resolves `{}`.
  - `mcpSubmitOAuthCallbackUrl('oauthy', 'http://localhost/callback')` rejects with: `Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.`
  - `mcpSubmitOAuthCallbackUrl('oauthy', 'http://localhost/callback?code=x&state=wrong')` rejects with: `Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch) or carries no authorization code. The sign-in in progress is still waiting; submit the redirect URL from its own browser page.`
- `MCP_STATUS_MESSAGES`: none. The SDK sends no message for an MCP status change; `system/init` did not arrive without a prompt (so it cannot be the first source), and what arrived instead (`system/hook_started`, `system/hook_response`, `system/commands_changed`) is not about MCP. Refresh by polling `mcpServerStatus()` (and after each action); a status read right after start can show `pending` for some servers for several seconds.
- `SOURCE_VALUES`: counts over the owner's 35 servers on This PC, plus the two the test added. `(source, scope, config.type)` → status: `claudeai / claudeai / claudeai-proxy` (claude.ai connectors: 25 `needs-auth`, 1 `connected`, 4 `pending`); `plugin / dynamic / http` (2: 1 `needs-auth`, 1 `pending`); `user / user / http` (1 `needs-auth`); `project / project / stdio` (the test's `echo`, `connected`); `project / project / http` (the test's `oauthy`, `needs-auth`). So a claude.ai connector shows `source: 'claudeai'`, `scope: 'claudeai'`, `config.type: 'claudeai-proxy'`, as expected; plugin servers have `scope: 'dynamic'`. Status values seen: `connected`, `needs-auth`, `pending`, `disabled` (after a toggle); `failed` was not seen in this run.

## Other notes

- Undeclared methods all work on Claude Code 2.1.318 through the `Query`: `mcpAuthenticate`, `mcpClearAuth`, `mcpSubmitOAuthCallbackUrl` (each returns the response object; errors arrive as a rejected promise with the quoted text).
- `reconnectMcpServer`, `toggleMcpServer` resolve `{}`/undefined; a reconnect of a server absent from the list (S7) works.
- Claude Code recorded the first temp folder in `~/.claude.json` (the toggled one: a `projects` entry with `disabledMcpServers`). It was left alone (read-only rule); it is one entry per run and the folder no longer exists.
- Resuming a session that never had a prompt fails ("No conversation found"); a "resume" check needs a real turn.

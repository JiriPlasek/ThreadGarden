# MCP servers in the chat: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude chat shows its MCP servers (source, status) in a dialog with Approve, Sign in, Reconnect, Turn off / on and Forget sign-in, and a banner when a project server waits for approval, the same on This PC, a paired machine and the phone.

**Architecture:** The live session's SDK controls (`mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`, plus the undeclared `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl`, `mcpClearAuth`) are wrapped once as `AgentSession.mcp`. A new `packages/service/src/mcp/` module reads `.mcp.json` and the approval lists, writes approvals into `<project>/.claude/settings.local.json`, and builds one `McpState` per chat. New `mcp.*` methods and an `mcp.changed` event (protocol 12, `mcp` capability) carry it to the UI, which adds a banner, a header menu item, a `/mcp` intercept and an `McpServersDialog`. When Claude Code does not pick an approval up live, the session restarts its process in place between turns (`LiveSession.restartWhenFree`).

**Tech Stack:** TypeScript, zod (protocol), Node 22 service, Agent SDK 0.3.314 with Claude Code 2.1.318, Svelte 5 + Tailwind (desktop/phone UI), Rust (phone core constants), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-mcp-servers-design.md`

## Global Constraints

- Claude chats only. Codex chats (`isCodexSession` / `isCodexChat`) show no banner, no dialog, no menu item, and `/mcp` is not intercepted for them.
- Threadgarden never writes to the Claude config dir. The only project file it writes is `<cwd>/.claude/settings.local.json`, and only the `enabledMcpjsonServers` entry (add the name) and the `disabledMcpjsonServers` entry (remove the name). It merges, keeps every other key and its order, and creates the file and folder when they're missing.
- Never store or log an OAuth token, auth code, sign-in link or callback URL. They pass through in method params and results only. They never go into `mcp.changed`, the database, `ui.error` or the service log.
- No approval without a click. Nothing approves a server automatically, and the banner's Approve approves only the server it names.
- Only project servers waiting for approval raise the banner. Needs sign-in and failed servers never do, from any source. The banner shows only once a session is live, and it can be dismissed for the session.
- No `needsYou`, notification or phone alert for MCP.
- Nothing wakes a chat by itself. **Wake the chat** goes through the same resume-safety check as sending.
- Protocol: `PROTOCOL_VERSION = 12`; `REMOTE_PROTOCOL_RANGE = { min: 11, max: 13 }` (own, one older, one newer, as for 10 and 11); capability `'mcp'` (`MCP_CAPABILITY`). A paired machine without `mcp` shows neither the banner nor the dialog.
- The undeclared SDK methods live in one typed wrapper in `real-adapter.ts`, next to `QueueControls`, with the note "recheck on every SDK update".
- Copy, fixed here: banner `MCP server "‹name›" (from this project) isn't approved yet.` (with more: `MCP server "‹name›" and ‹N› more (from this project) aren't approved yet.`); buttons `Approve`, `MCP servers…`; paste field label `Paste the address from your browser's address bar`; dialog title `MCP servers (this chat)`; statuses `Connected`, `Connecting…`, `Needs sign-in`, `Failed: ‹error›` (`Failed` with no error), `Off`, `Waiting for approval`, `Not approved` (rejected before).
- Run pnpm with `--config.verify-deps-before-run=false`, and don't reinstall node_modules (the no-links recipe). Commits carry no Claude attribution.

## Review Focus

1. **The settings file isn't plain JSON.** A `settings.local.json` with comments, a trailing comma or a non-object value is never overwritten. Approve fails with a message naming the file. Task 4 test `refuses an unreadable settings file`.
2. **`/mcp` reported as a supported command.** If the SDK lists `mcp` in `chat.commands`, `/mcp` must still open the dialog and never reach Claude (today an SDK-reported command beats the local table). Task 9 test `/mcp is intercepted even when the SDK reports it`.
3. **Approve during a turn, or while background tasks run.** The process never restarts mid-turn or with a permission request open. Tasks stop only after **Restart now**. Task 5 tests `waits for the turn to end` and `keeps running tasks unless told`.
4. **Another chat in the same project has running tasks.** Someone else's Approve must not kill them: that chat restarts only once it's idle with no running tasks. Task 6 test `other live chats in the project restart only when free`.
5. **An SDK error carries the callback URL.** For example `Invalid callback http://localhost:…?code=…`. It goes back to the caller as `MCP_FAILED` and is never logged by the router. Task 6 test `never logs a callback URL`.

---

### Task 1: Spike on the real CLI

**Files:**
- Create: `packages/service/test/real/mcp.real.test.ts` (opt-in; kept as the "recheck on every SDK update" check for the undeclared methods)
- Create: `packages/service/test/real/fixtures/echo-mcp-server.mjs` (a stdio MCP server in plain Node: newline-delimited JSON-RPC answering `initialize`, `tools/list` with one `echo` tool, and `tools/call`; no imports beyond `node:readline`)
- Create: `docs/superpowers/specs/2026-11-22-mcp-servers-spike-results.md`

**Interfaces:**
- Produces: the spike results doc, with a "Constants for the build" section naming these values, which later tasks read:
  - `UNAPPROVED_SHOWS_AS`: `'absent'`, or the `McpServerStatus.status` an unapproved project server reports (and the `source`/`scope` it carries).
  - `APPROVAL_IS_LIVE: boolean`: true when a `reconnectMcpServer` after writing the approval brings the server up in the same process.
  - `APPROVALS_READ_FROM`: the files whose `enabledMcpjsonServers` / `disabledMcpjsonServers` / `enableAllProjectMcpServers` Claude Code honours (expected: project `.claude/settings.local.json` and `.claude/settings.json`, user `~/.claude/settings.json`).
  - `TOGGLE_SAVED_IN`: `'none'`, `'project'` or `'user'`, plus the file it lands in.
  - `AUTH_START`: what `mcpAuthenticate` returns (its JSON shape: the link's key, any "already signed in" or callback hint), and whether passing `redirectUri` changes the link or the local listener.
  - `MCP_STATUS_MESSAGES`: the SDK message types/subtypes that arrive when an MCP server's status changes (beyond `system/init`).
  - `SOURCE_VALUES`: the `source`/`scope`/`config.type` values seen, and how a claude.ai connector shows (expected `source: 'claudeai'`, `config.type: 'claudeai-proxy'`).

Each check runs in a fresh temp folder that `claude` has never opened (so it's untrusted). The folder holds a `.mcp.json` naming `echo` (the fixture, via `process.execPath`) and `oauthy` (`{ "type": "http", "url": "https://mcp.linear.app/mcp" }`, a public server that uses OAuth with dynamic client registration; no sign-in is ever completed). It uses `RealAdapter` with the user's own login and sends no prompt, only control requests. Report lines use the `[threadgarden-real]` prefix. Record only counts per source/status from the user's own servers, never their names.

- [ ] **Step 1: Write the checks** as `it` blocks, skipped unless `THREADGARDEN_REAL=1`:
  - `S1 unapproved project server`: `mcp.status()` and `system/init.mcp_servers` before any approval. Report `echo`'s entry, or that it's absent.
  - `S2 approval picked up live`: write `{ enabledMcpjsonServers: ['echo'] }` to `.claude/settings.local.json` mid-session. Report `mcp.status()` for `echo`, then `reconnect('echo')` and its status after up to 10 s. Then resume a new process with the same session id and report `echo`'s status there.
  - `S3 folder trust`: does S2's server connect in the untrusted folder at all (report yes/no).
  - `S4 sign-in`: approve `oauthy` too. Report `authenticate('oauthy')` raw, `authenticate('oauthy', 'http://localhost:1/cb')` raw, `submitCallback('oauthy', 'http://localhost/callback')` (no code) and `submitCallback('oauthy', 'http://localhost/callback?code=x&state=wrong')` errors verbatim, and `clearAuth('oauthy')` raw.
  - `S5 status messages`: every SDK message `type/subtype` seen during S2 and S4 that isn't `system/init`.
  - `S6 toggle`: `toggle('echo', false)`. Report which of `<tmp>/.claude/settings.local.json`, `<tmp>/.claude/settings.json`, `~/.claude/settings.json` and the temp project's entry in `~/.claude.json` changed (read and compare before/after), and `echo`'s status in a fresh resumed process. Then `toggle('echo', true)`.
  - `S7 rejected`: a fresh folder with `disabledMcpjsonServers: ['echo']`. Report `echo`'s status. Then move it to `enabledMcpjsonServers` and report what S2's path does.
  - `S8 sources`: counts of `(source, scope, status, config.type)` over all servers in S1.
  - Cleanup in `afterAll`: `clearAuth('oauthy')` and remove the temp folders. Report any entry Claude Code left for them in `~/.claude.json`, but don't edit that file.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real -- mcp` and keep the output.
- [ ] **Step 3: Write the results doc** in the style of `2026-11-02-move-chat-spike-results.md`: the setup, a table with one row per check (result, evidence), any finding that changes the design, and the "Constants for the build" section. If a result contradicts the spec (for example, unapproved servers are invisible *and* `.mcp.json` lives somewhere other than the cwd), stop and report it before Task 2.
- [ ] **Step 4: Commit** `docs: MCP servers spike results` (the test, the fixture and the doc).

### Task 2: Protocol 12

**Files:**
- Create: `packages/protocol/src/mcp.ts`, `packages/protocol/test/mcp.test.ts`
- Modify: `packages/protocol/src/{methods,events,version,machines,index}.ts`; the version and range pins in `packages/protocol/test/{away,move,projects,power,update,usage,schemas}.test.ts`, `packages/protocol/test/fixtures/protocol-range.json`, `apps/desktop/tests/state/machines.test.ts` (`accepts a remote on protocol 11 or 13 but not 10 or 14`), `apps/desktop/src-tauri/src/service.rs` (`PROTOCOL_VERSION: u32 = 12`), `apps/desktop/src-tauri/core/src/lib.rs` (`PROTOCOL_VERSION = 12`, `REMOTE_PROTOCOL_RANGE = (11, 13)`), `apps/desktop/src-tauri/core/src/methods.rs` (the new methods into `REFUSED`: the phone's own core has no chats), `packages/protocol/test/fixtures/core-answers/*` (regenerated)

**Interfaces:**
- Produces:
  - `MCP_CAPABILITY = 'mcp'`.
  - `McpStatusSchema = z.enum(['connected', 'pending', 'needs-auth', 'failed', 'disabled', 'unapproved'])`.
  - `McpServerSchema = z.object({ name: z.string(), source: z.string(), status: McpStatusSchema, error: z.string().optional(), rejected: z.boolean().optional(), claudeAi: z.boolean(), canSignIn: z.boolean() })`. `source` is the SDK's `source ?? scope ?? ''`. `rejected` is set only on `unapproved` servers in `disabledMcpjsonServers`. `canSignIn` is true for http/sse servers that aren't claude.ai connectors.
  - `McpRestartSchema = z.object({ when: z.enum(['turn', 'tasks']), tasks: z.number().int().nonnegative() })`.
  - Inferred types `McpStatus`, `McpServer`, `McpRestart`, `McpState` exported beside each schema.
  - `McpStateSchema = z.object({ sessionId: z.string(), live: z.boolean(), servers: z.array(McpServerSchema), waiting: z.array(z.string()), restart: McpRestartSchema.nullable() })`. `waiting` holds the banner's names, in `.mcp.json` order, never including rejected ones.
  - Methods (none `localOnly`: a paired device has full control of chats):
    - `mcp.list {sessionId} → McpState`;
    - `mcp.approve {sessionId, name} → { next: 'connected' | 'restarting' | 'confirm', tasks: number }`;
    - `mcp.restart {sessionId, when: 'now' | 'whenFinished'} → {}`;
    - `mcp.signIn {sessionId, name} → { url: string | null }` (null: nothing to open, already signed in);
    - `mcp.submitCallback {sessionId, name, url: z.string().url()} → {}`;
    - `mcp.act {sessionId, name, action: z.enum(['reconnect', 'enable', 'disable', 'clearAuth'])} → {}`;
    - `chat.wake {sessionId} → {}`.
  - Event `'mcp.changed': McpStateSchema`.
  - Error codes (`MCP_ERRORS`): `MCP_UNSUPPORTED` (Codex chat), `MCP_FAILED` (Claude Code's own words), `SETTINGS_UNREADABLE`. Existing `NOT_LIVE`, `NOT_FOUND`, `INVALID_PARAMS` and `RESUME_BLOCKED` are reused.

- [ ] **Step 1: Write the failing tests** in `mcp.test.ts`:
  - `PROTOCOL_VERSION is 12 and the remote range is 11..13`;
  - `MCP_CAPABILITY is 'mcp' and not in CAPABILITIES` (it's added at runtime, like `away`);
  - `McpServerSchema parses every status and refuses an unknown one`;
  - `mcp.* methods, chat.wake and mcp.changed are listed`;
  - `mcp.submitCallback refuses a url that isn't a URL`.
  - Update the old pins (10..12 → 11..13, 11 → 12) and the fixture's samples (10, 11, 13, 14).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol exec vitest run`. Expect FAIL.
- [ ] **Step 3: Implement.** `version.ts` gets the line `12 — MCP servers in the chat: mcp.*, chat.wake, mcp.changed, the mcp capability.` Add the Rust constants and the `REFUSED` entries, then regenerate the core's answers with `THREADGARDEN_WRITE_FIXTURES=1 cargo test --test contract` (in `apps/desktop/src-tauri/core`).
- [ ] **Step 4: Run** the protocol tests, `cargo test` in `apps/desktop/src-tauri/core` and `cargo test protocol_version` in `apps/desktop/src-tauri`, and the desktop `tests/state/machines.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(protocol): protocol 12 for MCP servers in the chat`.

### Task 3: MCP controls on the session

**Files:**
- Modify: `packages/service/src/sdk/adapter.ts` (the `McpControls` type, `AgentSession.mcp?`)
- Modify: `packages/service/src/sdk/real-adapter.ts` (the `McpUndeclared` type beside `QueueControls`, and `RealSession.mcp`)
- Modify: `packages/service/src/testing/fake-adapter.ts` (`FakeSession.mcp`, scriptable)
- Test: `packages/service/test/sdk/real-adapter.test.ts`, `packages/service/test/testing/fake-adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpControls {
    status(): Promise<McpServerStatus[]>;            // Query.mcpServerStatus
    reconnect(name: string): Promise<void>;          // Query.reconnectMcpServer
    toggle(name: string, enabled: boolean): Promise<void>; // Query.toggleMcpServer
    authenticate(name: string, redirectUri?: string): Promise<unknown>; // mcp_authenticate
    submitCallback(name: string, callbackUrl: string): Promise<unknown>; // mcp_oauth_callback_url
    clearAuth(name: string): Promise<unknown>;       // mcp_clear_auth
  }
  ```
  `AgentSession` gains `readonly mcp?: McpControls`. Claude sessions have it; the Codex adapter's sessions don't (no change there). Re-export `McpServerStatus` from `adapter.ts`.
  `FakeSession` gains `mcpServers: McpServerStatus[]`, `mcpCalls: { op: string; name: string; arg?: unknown }[]`, `authResult: unknown`, `mcpError: Error | undefined` (when set, every control call rejects with it after recording), and an `mcp` that reads and records against them.

- [ ] **Step 1: Write the failing tests.**
  - `real-adapter.test.ts` `forwards MCP controls to the query`: add `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`, `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl`, `mcpClearAuth` mocks to `fakeQuery`. Expect `s.mcp!.status()` to resolve to the mock's list, `reconnect('a')` to call `reconnectMcpServer('a')`, `toggle('a', false)` to call `toggleMcpServer('a', false)`, `authenticate('a')` to call `mcpAuthenticate('a', undefined)` and resolve its value, `submitCallback('a', 'http://x/cb?code=1')` to call `mcpSubmitOAuthCallbackUrl('a', 'http://x/cb?code=1')`, and `clearAuth('a')` to call `mcpClearAuth('a')`.
  - `fake-adapter.test.ts` `records MCP calls and rejects with mcpError`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/sdk/real-adapter.test.ts test/testing/fake-adapter.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Write `McpUndeclared` with the doc comment "`Query` methods SDK 0.3.314 has but does not declare … handled by Claude Code 2.1.318 in SDK mode; recheck on every SDK update". Build `RealSession.mcp` once in the constructor.
- [ ] **Step 4: Run** the same tests and the service typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): MCP controls on a Claude session`.

### Task 4: Project files and the MCP state

**Files:**
- Create: `packages/service/src/mcp/project-files.ts`, `packages/service/src/mcp/state.ts`
- Test: `packages/service/test/mcp/project-files.test.ts`, `packages/service/test/mcp/state.test.ts`

**Interfaces:**
- Consumes: `McpServerStatus` (Task 3), `McpServer`, `McpState` (Task 2), the Task 1 constants.
- Produces:
  - `export type Approvals = { enabled: string[]; disabled: string[]; enableAll: boolean }`.
  - `export interface McpProjectFiles { mcpJsonNames(cwd: string): Promise<string[]>; approvals(cwd: string): Promise<Approvals>; approve(cwd: string, name: string): Promise<void> }`.
  - `export const diskProjectFiles: McpProjectFiles`. `mcpJsonNames` gives the keys of `<cwd>/.mcp.json`'s `mcpServers` (`[]` when the file is missing or unreadable). `approvals` merges the lists from every file in `APPROVALS_READ_FROM`, read-only. `approve` merges into `<cwd>/.claude/settings.local.json`: it writes a temp file in the same folder and renames it over the original, using `JSON.stringify(obj, null, 2) + '\n'`. Writes are serialised per file path, and an invalid file throws `ServiceError('SETTINGS_UNREADABLE', "‹path› isn't valid JSON, so Threadgarden left it alone. Fix it, then approve again.")`.
  - `export const buildMcpState = (sessionId: string, statuses: McpServerStatus[], project: { names: string[]; approvals: Approvals }, restart: McpRestart | null) => McpState` (pure, `live: true`).
  - `export const signInUrl = (raw: unknown): string | null` (parses `AUTH_START`).
  - `export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors'`.
  - The spike's answers as code, in `state.ts`, each with a comment pointing at the results doc: `export const UNAPPROVED_SHOWS_AS: 'absent' | McpServerStatus['status']`, `export const APPROVAL_IS_LIVE: boolean`, `export const TOGGLE_SAVED_IN: 'none' | 'project' | 'user'`, and `export const isMcpStatusMessage = (m: SDKMessage): boolean` (true for `system/init` and the `MCP_STATUS_MESSAGES` kinds).

The rules for `buildMcpState`:
- A project server is unapproved when it's in `names`, isn't in `approvals.enabled`, `enableAll` is false, and (per `UNAPPROVED_SHOWS_AS`) it's absent from `statuses` or reports that status.
- An unapproved server appears in `servers` as `status: 'unapproved'`, `source: 'project'`, with `rejected` true when it's in `approvals.disabled`. It goes into `waiting` only when it isn't rejected.
- Every other status keeps the SDK's status, error and source.
- `claudeAi` is set when source/scope is `claudeai` or `config.type === 'claudeai-proxy'` (adjust to `SOURCE_VALUES`). `canSignIn` is set when `config.type` is `http` or `sse` and the server isn't a claude.ai connector.
- Order: unapproved first (in `.mcp.json` order), then needs-auth, failed, pending, connected, off, each sorted by name.

- [ ] **Step 1: Write the failing tests.**
  - `project-files.test.ts` (temp dirs):
    - `reads server names from .mcp.json` (and `[]` for a missing or broken file);
    - `approve creates the folder and file`: the file equals `{ "enabledMcpjsonServers": ["etoro"] }` plus a newline;
    - `approve keeps every other key and their order`: given `{ "permissions": {…}, "enabledMcpjsonServers": ["a"], "x": 1 }`, the keys come out as `permissions, enabledMcpjsonServers, x` and `enabledMcpjsonServers` is `["a", "etoro"]`;
    - `approve takes the name off disabledMcpjsonServers` (`["etoro", "b"]` → `["b"]`);
    - `approving twice adds the name once`;
    - `two approvals at once keep both names`;
    - `refuses an unreadable settings file`: `{ // comment` and `[]` make it throw `SETTINGS_UNREADABLE`, and the file's bytes don't change;
    - `approvals merges the lists it reads` (per `APPROVALS_READ_FROM`).
  - `state.test.ts`:
    - `an unapproved project server is waiting`;
    - `a rejected one is listed as rejected and not waiting`;
    - `enableAllProjectMcpServers approves every project server`;
    - `a turned-off approved server is Off, not waiting`;
    - `claude.ai connectors can't sign in here; http servers can; stdio servers can't`;
    - `failed keeps Claude Code's error`;
    - `orders unapproved, needs sign-in, failed, connecting, connected, off`;
    - `signInUrl reads the link` (the `AUTH_START` shape, and null without a link).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/mcp`. Expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): read and approve a project's MCP servers`.

### Task 5: Restart between turns, and the MCP hook

**Files:**
- Modify: `packages/service/src/chat/live-session.ts`, `packages/service/src/chat/session-host.ts`
- Test: `packages/service/test/chat/live-session.test.ts`, `packages/service/test/chat/session-host.test.ts`

**Interfaces:**
- Consumes: `McpControls` (Task 3); `isMcpStatusMessage`, `McpRestart` (Tasks 4, 2).
- Produces:
  - `LiveSessionDeps.onMcpChange?: (sessionId: string) => void`. It's called for every message where `isMcpStatusMessage(m)` is true (Task 4), so on every `system/init` of a process and on the MCP status messages the spike found. A throw is reported. `SessionHost.options()` passes it through like the other hooks.
  - `LiveSession.mcpControls(): McpControls`. It throws `ServiceError('NOT_LIVE', …)` without a process, and `ServiceError('MCP_UNSUPPORTED', 'MCP servers are for Claude chats')` when the session has no `mcp`.
  - `LiveSession.restartWhenFree(o: { stopTasks: boolean }): void` and `get pendingRestart(): McpRestart | null`. The process restarts in place once all of these hold: status is `idle`, no request is pending, nothing is queued, and either `stopTasks` is set or `runningTasks === 0`. It's checked on each status change and each running-task change. In place means closing the current process without the "ended unexpectedly" line or a `paused` status, then `startProcess({ resume: id, sessionStore })` on the same object. The status stays `idle`, `seq` continues, and items and the history cache owner are kept. `stopTasks: true` beats an earlier `false`. `end()`/`pause()`/a crash drop the pending restart. `pendingRestart` reports `when: 'turn'` while a turn or request holds it and `when: 'tasks'` while tasks hold it.
  - `SessionHost.liveIn(cwd: string): LiveSession[]` returns the live Claude sessions whose cwd is the same folder (`path.resolve`, case-insensitive on win32).

- [ ] **Step 1: Write the failing tests** (FakeAdapter):
  - `restartWhenFree restarts at once when idle`: `adapter.started` has a second session with `resume: <id>`, the first is `closed`, no system error item is pushed, no `chat.status` with `paused` or `failed` is emitted, and `seq` keeps rising;
  - `waits for the turn to end`: during a turn nothing restarts, and after the `result` it does;
  - `waits while a permission request is open`;
  - `keeps running tasks unless told`: with a running task, `{ stopTasks: false }` waits until the task ends, and `{ stopTasks: true }` restarts at the next idle;
  - `pendingRestart says what it waits for`;
  - `end drops a pending restart`;
  - `a moved chat restarts from its store` (`sessionStore` is passed again);
  - `onMcpChange is called for each system/init and MCP status message, a throw is reported`;
  - `mcpControls refuses without a process and for a session without mcp`;
  - `session-host.test.ts` `liveIn lists live Claude chats in the same folder` (not other folders, not paused, not Codex; `C:\P` matches `c:\p\` on win32).
- [ ] **Step 2: Run** the chat tests. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole service suite (idle reclaim, queued messages and tasks tests must still pass). Expect PASS.
- [ ] **Step 5: Commit** `feat(service): a chat can restart its process between turns`.

### Task 6: The `mcp.*` handlers and `chat.wake`

**Files:**
- Create: `packages/service/src/server/handlers/mcp.ts`
- Modify: `packages/service/src/server/handlers/chat.ts` (register `chat.wake` next to `chat.send`, on the same `resumedOrLive`), `packages/service/src/main.ts` (accept `mcpFiles?: McpProjectFiles` in the start options, default `diskProjectFiles`; register the handlers; wire `onMcpChange` to `refresh`; add `MCP_CAPABILITY` to both `capabilities` branches beside `AWAY_CAPABILITY`)
- Test: `packages/service/test/server/mcp-handlers.test.ts`, `packages/service/test/server/chat-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `registerMcpHandlers(router: Router, deps: { host: SessionHost; files: McpProjectFiles; emit: (e: EventMsg) => void; onError: (err: unknown, context: string) => void }): { refresh(sessionId: string): Promise<void> }`. `refresh` builds the state and emits `mcp.changed`. `main.ts` calls it from `onMcpChange`, and does nothing for Codex.

Behaviour:
- `mcp.list`: for a chat with no live process, `{ live: false, servers: [], waiting: [], restart: null }`. A Codex chat gets `MCP_UNSUPPORTED`. Otherwise `buildMcpState` from `mcpControls().status()`, the files and `pendingRestart`.
- `mcp.approve`: the name must be in `mcpJsonNames(cwd)`, else `INVALID_PARAMS` (`"‹name›" isn't a server in this project's .mcp.json`). Then `files.approve`. If `APPROVAL_IS_LIVE`, reconnect it in this chat and in every other `liveIn(cwd)` chat, and answer `next: 'connected'`. Otherwise this chat answers `confirm` with `tasks: runningTasks` when tasks run, else calls `restartWhenFree({ stopTasks: false })` and answers `restarting`. Every other `liveIn(cwd)` chat gets `restartWhenFree({ stopTasks: false })` (it never loses tasks to this click). Then `refresh` each affected chat.
- `mcp.restart`: `now` → `restartWhenFree({ stopTasks: true })`; `whenFinished` → `{ stopTasks: false }`; then `refresh`.
- `mcp.signIn`: a claude.ai connector gets `INVALID_PARAMS` (the UI links to claude.ai instead). Otherwise `signInUrl(await authenticate(name))`, passing `redirectUri` only if `AUTH_START` showed it helps, then `refresh`.
- `mcp.submitCallback`, `mcp.act`: they call the matching control, then `refresh`.
- Every control failure becomes `ServiceError('MCP_FAILED', <Claude Code's message as is>)`, so the router never logs it, and no handler passes params or results to `onError`.
- `chat.wake`: `await resumedOrLive(sessionId)` (requires runnable, resume check `blocked` → `RESUME_BLOCKED`, the same moved/moving refusals as `chat.send`), returns `{}`, sends nothing.

- [ ] **Step 1: Write the failing tests** (`startService` over FakeAdapter, as in `chat-handlers.test.ts`, with an in-memory `McpProjectFiles` as `mcpFiles`):
  - `list says not live for a paused chat`;
  - `list builds the state from the session and the files`;
  - `list refuses a Codex chat`;
  - `approve writes and restarts an idle chat` (`next: 'restarting'`, the file has the name, a second process starts, `mcp.changed` is emitted);
  - `approve asks first when tasks run` (`next: 'confirm', tasks: 2`, nothing restarts until `mcp.restart {when: 'now'}`);
  - `other live chats in the project restart only when free` (another chat in the same cwd with a running task doesn't restart until it ends; a chat in another cwd is untouched);
  - if `APPROVAL_IS_LIVE`: `approve reconnects instead of restarting`;
  - `approve refuses a name not in .mcp.json`;
  - `signIn returns the link and refreshes`;
  - `act maps reconnect, enable, disable and clearAuth`;
  - `never logs a callback URL`: with `mcpError = new Error('Invalid callback http://localhost:5/cb?code=SECRET')`, `submitCallback` answers `MCP_FAILED` with that message and the router's log and `onError` get nothing containing `SECRET`;
  - `init emits mcp.changed`: a `system/init` from the fake session emits it;
  - `chat-handlers.test.ts` `wake resumes without sending` (the session starts with `resume`, `sent` stays empty), `wake honours a blocked resume check` (`RESUME_BLOCKED`);
  - `hello advertises mcp` (local and headless).
- [ ] **Step 2: Run** the server tests. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole service suite and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): mcp.* methods and Wake the chat`.

### Task 7: Fake servers in the mock

**Files:**
- Modify: `packages/service/src/testing/mock-main.ts` (doc comment, `ScriptedSession`, an in-memory `McpProjectFiles` passed as `mcpFiles`, the mock-only `mock.mcpReset`)
- Test: `packages/service/test/testing/mock-main.test.ts`

**Interfaces:**
- Produces: in every mock Claude chat, servers in every state:
  - `github` (user, Connected);
  - `mock-notion` (claudeai, Needs sign-in);
  - `mock-oauth` (user, http, Needs sign-in);
  - `context7` (plugin, Failed: `timeout`);
  - `mock-slow` (user, Connecting…);
  - `mock-off` (local, Off).
  - Chats in `/work/proj-0` (and the remote mock's `tg-cli`) also have `.mcp.json` names `mock-etoro` (waiting) and `mock-old` (rejected).
  - Approve on the in-memory files makes the restarted process report `mock-etoro` as Connected.
  - `authenticate` returns the `AUTH_START` shape with `http://127.0.0.1:‹mock port›/mock-oauth?server=‹name›`. On This PC's mock the server turns Connected about 500 ms later. On the remote mock it waits for `submitCallback` with a URL containing `code=`, and any other URL rejects with `Missing authorization code`.
  - `reconnect` turns a failed server Connecting… then Connected. `toggle` sets Off/Connecting…. `clearAuth` turns an http server Needs sign-in.
  - `mock.mcpReset` (local callers only) puts every chat's servers and the files back to the start, so e2e specs don't leak into each other.

- [ ] **Step 1: Write the failing tests** in `mock-main.test.ts`:
  - `a proj-0 chat lists servers in every state` (all six statuses appear in `mcp.list` after a send);
  - `approve brings mock-etoro up`;
  - `the remote mock wants a pasted callback`;
  - `mock.mcpReset forgets approvals`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the service suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(mock): fake MCP servers in every state`.

### Task 8: The MCP servers dialog

**Files:**
- Create: `apps/desktop/src/lib/state/mcp.svelte.ts`, `apps/desktop/src/lib/components/chat/mcp.ts` (pure labels and actions), `apps/desktop/src/lib/components/chat/McpServersDialog.svelte`
- Modify: `apps/desktop/src/lib/state/chats.svelte.ts` (`wake(sessionId): Promise<void>` → `chat.wake`)
- Test: `apps/desktop/tests/chat/mcp.test.ts`, `apps/desktop/tests/chat/mcp-dialog.test.ts`

**Interfaces:**
- Consumes: the Task 2 schemas and methods, `openExternal` (`#lib/native.js`).
- Produces:
  - `export class ChatMcp { state = $state.raw<McpState | null>(null); constructor(api: Api, sessionId: string); load(): Promise<void>; startPolling(): () => void; approve(name): Promise<Result<'mcp.approve'>>; restart(when): Promise<void>; signIn(name): Promise<string | null>; submitCallback(name, url): Promise<void>; act(name, action): Promise<void>; stop(): void }`. It subscribes to `mcp.changed` for its session, loads on open and on reconnect, and `startPolling` re-reads `mcp.list` every `MCP_POLL_MS = 3000` until the returned stop is called.
  - `mcp.ts`:
    - `statusLabel(s: McpServer): string` (the Global Constraints copy);
    - `sourceLabel(source: string): string`: `project`, `user`, `local`, `plugin` as they are; `claudeai` → `claude.ai`; `managed`/`enterprise` → `managed`; anything else as is;
    - `primaryAction(s): 'approve' | 'signIn' | 'claudeAiSignIn' | 'reconnect' | 'turnOn' | null`;
    - `menuActions(s): ('reconnect' | 'turnOff' | 'clearAuth')[]`;
    - `turnOffLabel`: per `TOGGLE_SAVED_IN`, `'Turn off in this project'`, `'Turn off for this chat'` or `'Turn off on this machine'`;
    - `clearAuthLabel(machine: string): string` = `` `Forget sign-in on ${machine}` ``.

    The action table:

    | Status | Primary | Menu |
    |---|---|---|
    | `unapproved` | `approve` | none |
    | `needs-auth` | `signIn` (claude.ai: `claudeAiSignIn`) | `reconnect`, `turnOff` |
    | `failed` | `reconnect` | `turnOff`, plus `clearAuth` if `canSignIn` |
    | `connected` | none | `reconnect`, `turnOff`, plus `clearAuth` if `canSignIn` |
    | `pending` | none | `turnOff` |
    | `disabled` | `turnOn` | none |
  - `McpServersDialog.svelte` props: `{ open: boolean (bindable); mcp: ChatMcp; live: boolean; remote: boolean; machineName: string; onWake: () => Promise<void> }`. It renders:
    - a row per server: name, `sourceLabel`, `statusLabel`, the primary button, and a `⋯` menu;
    - a not-live state: text `This chat isn't running. Wake it to see its MCP servers.` and a `Wake the chat` button;
    - after Approve answers `confirm`, a confirm step: `Restart now (stops ‹N› task‹s›)` / `When they finish`;
    - while `restart` is pending, a line `Restarts when this turn ends` / `Restarts when its tasks finish`;
    - after Sign in on a `remote` machine, the paste field with its label and a `Finish sign-in` button;
    - for a claude.ai connector, Sign in opens `CLAUDE_AI_CONNECTORS_URL`;
    - errors from any action appear under the row, word for word.

- [ ] **Step 1: Write the failing tests.**
  - `mcp.test.ts`: `statusLabel` for each status (including `Failed` with no error, and `Not approved` when rejected); `sourceLabel('claudeai')` is `claude.ai`; the action table, row by row; `ChatMcp` `polls while open and stops after` (fake timers, fake Api counts `mcp.list` calls); `ChatMcp` `ignores mcp.changed of other chats`.
  - `mcp-dialog.test.ts` (testing-library, fake ChatMcp state):
    - `lists every server with source and status`;
    - `Approve, then confirm names the tasks` (`Restart now (stops 2 tasks)`, and `When they finish` calls `restart('whenFinished')`);
    - `Sign in opens the link; on a remote machine the paste field appears and sends what was pasted`;
    - `on This PC no paste field`;
    - `claude.ai Sign in opens claude.ai's connector settings`;
    - `not live shows Wake the chat and calls onWake`;
    - `an action's error is shown as Claude Code words it`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/chat/mcp`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, desktop typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): the MCP servers dialog`.

### Task 9: Banner, header menu, `/mcp` and Wake

**Files:**
- Modify: `apps/desktop/src/lib/components/chat/ChatView.svelte` (a `ChatMcp` per Claude chat on an `mcp` machine; the banner; the dialog; refactor `submit` into `withResumeCheck(run: () => Promise<boolean>)`, used by sending and by Wake), `apps/desktop/src/lib/components/chat/ChatHeader.svelte` (an `MCP servers…` menu item, on the phone too, via a new `onOpenMcp?: () => void` prop), `apps/desktop/src/lib/components/composer/commands.ts`, `apps/desktop/src/lib/components/composer/Composer.svelte` (`onControl` handles `'mcp'`), `apps/desktop/src/lib/projects.ts` (`supportsMcp(m: MachineEntry | undefined): boolean`)
- Test: `apps/desktop/tests/chat/mcp-banner.test.ts`, `apps/desktop/tests/interaction/composer.test.ts`

**Interfaces:**
- Consumes: Task 8.
- Produces:
  - `Control` gains `'mcp'`. The `mapped` table gains `{ name: 'mcp', description: 'Manage MCP servers (opens the MCP servers dialog)', control: 'mcp' }`, and `localCommand` returns it even when the SDK reports `mcp` (`ALWAYS_LOCAL = ['mcp']`). `menuCommands` lists the local `mcp` entry in place of a reported one.
  - Where it shows: a chat shows MCP (`mcpOn`) when `!isCodexChat(sessionId) && supportsMcp(entry) && !readOnly`. Without it, `onControl('mcp')` returns `MCP servers are for Claude chats.` for Codex, and `Update ‹machine› to manage MCP servers from here.` for an old machine.
  - The banner shows when `mcpOn`, the chat is `ownedLive`, `state.waiting.length > 0`, and it isn't dismissed (dismissal is held per `sessionId` in component state, cleared when the process restarts). It has `Approve` (approves `waiting[0]`, then follows the same confirm flow as the dialog), `MCP servers…`, and a dismiss ×.
  - `remote` for the dialog is `!entry.local` (always true on the phone).

- [ ] **Step 1: Write the failing tests.**
  - `mcp-banner.test.ts` (ChatView harness as in `remote-chat.test.ts`):
    - `shows the banner for a waiting project server`, with the copy for one server, and `and 2 more … aren't approved yet` for three;
    - `no banner for needs sign-in or failed servers`;
    - `no banner and no mcp request for a Codex chat`;
    - `no banner, no menu item, no request on a machine without mcp`;
    - `no banner for a paused chat` (and no `chat.wake` call);
    - `Approve approves the named server only`;
    - `dismiss hides it for this session`;
    - `the header menu opens the dialog` (desktop and phone header);
    - `Wake goes through the resume check` (`unverified` asks first, `blocked` shows the blocked banner, `ok` calls `chat.wake`).
  - `composer.test.ts`:
    - `/mcp opens the MCP dialog and is not sent`;
    - `/mcp is intercepted even when the SDK reports it`;
    - `/mcp in a Codex chat says why`.
- [ ] **Step 2: Run** the desktop tests named above. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole desktop suite, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): MCP banner, menu item and /mcp`.

### Task 10: End to end, docs, wrap-up

**Files:**
- Create: `apps/desktop/e2e/mcp.spec.ts`
- Modify: `docs/architecture.md` (protocol 12 in Lifecycle → Versions and Protocol; a short "MCP servers" paragraph under Live chats: what's read, the one file written, restart between turns, the undeclared SDK methods), `README.md` (a feature line), `packages/service/README.md` if it lists handlers

- [ ] **Step 1: Write `mcp.spec.ts`** against the mock (call `mock.mcpReset` in `beforeEach`):
  - `banner → Approve → mock-etoro connects` in a `proj-0` chat;
  - `/mcp opens the dialog with every status`;
  - `Reconnect a failed server`;
  - `Turn off and on`;
  - `sign in on the remote mock needs the pasted address` (paired remote mock; a wrong address shows `Missing authorization code`);
  - `a paused chat offers Wake the chat`;
  - `the phone layout opens the dialog from the header menu`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop test:e2e mcp` (if Chromium is installed), then `interface-size` and `screenshots`. The banner must not appear in the README screenshots' chats (they aren't in `proj-0`; check every image).
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run** the full protocol, service and desktop suites. Expect PASS.
- [ ] **Step 5: Commit** `docs: MCP servers in the chat`.
- [ ] **Step 6: Hardware check with the owner.** On kumbal: open `etoro_analysis` and check the banner, Approve, the server connecting, Sign in with the pasted address (the real `mcpSubmitOAuthCallbackUrl` path), Forget sign-in and Turn off. Do the same from the phone. Record the result in the spike results doc's last section.
- [ ] **Step 7:** Update the vault (`Threadgarden/Remote machines.md` or the hub's "Now", whichever lists this feature): mark MCP done and move piece 2 (`!` commands) to next. Commit and push the vault.
- [ ] **Step 8:** Open the PR into `main`.

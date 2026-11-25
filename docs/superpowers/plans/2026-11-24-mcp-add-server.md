# Add and remove MCP servers from the chat: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The MCP servers dialog can add a server (http or stdio, with headers or environment, in a chosen scope) and remove a `local` / `user` / `project` server, on the chat's machine, from the desktop and the phone.

**Architecture:** The service runs the `claude` it already located for the SDK, as `claude mcp add-json --scope <scope> <name> -` (the JSON on stdin) and `claude mcp remove --scope <scope> <name>`, in the chat's folder with the session environment. That runner is `packages/service/src/mcp/config.ts`. Two new methods, `mcp.add` and `mcp.remove`, sit beside the other `mcp.*` handlers. Each runs the CLI, then makes the live chat see the change the way the spike (Task 1) found works: a status read, a reconnect, or a restart between turns. They're gated by a new runtime capability, `mcp-config`. The desktop gets an add form in the dialog and a Remove item in the row's **⋯** menu, behind a confirmation.

**Tech Stack:** TypeScript, zod (protocol), Node 22 service, Agent SDK 0.3.314 with Claude Code 2.1.318, Svelte 5 + Tailwind, Rust (the phone core's `REFUSED` list), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-mcp-add-server-design.md` (on top of `2026-11-22-mcp-servers-design.md` and its "After the spike" section)

## Global Constraints

- Protocol: `PROTOCOL_VERSION` stays `12` and `REMOTE_PROTOCOL_RANGE` stays `{ min: 11, max: 13 }`. Everything here ships unreleased in 0.12.0. The feature is gated by `MCP_CONFIG_CAPABILITY = 'mcp-config'`, which `main.ts` adds at runtime on every service (both `capabilities` branches, beside `MCP_CAPABILITY`). It is not in `CAPABILITIES`.
- Claude chats only, on a machine that offers `mcp-config`. Without it, the dialog has no **Add server** and no **Remove**. Codex chats have no dialog at all (unchanged).
- Threadgarden never writes Claude Code's config files. Only Claude Code's CLI does: `claude mcp add-json` and `claude mcp remove`, run with the path the SDK uses (`claude.current.path`). On a native Windows worker that's the same `claude.exe`; under WSL it's the Linux `claude`. The CLI runs with `cwd` = the chat's folder and `env` = `sessionEnvOf()`, so it sees the same config dir as the chat.
- Header and environment values (API keys) are never logged and never put in events, errors, `ui.error` or the database. They go to the CLI only on stdin (`add-json … -`), never in process arguments. The form shows them masked (`type="password"`).
- **Who uses it** → scope: `Me, this project` = `local` (the default), `Me, every project` = `user`, `Everyone (.mcp.json)` = `project`. Under *Everyone*, the note reads `Saved in this project's .mcp.json, which is usually committed and shared with everyone who clones the project.`
- **Remove** shows only for servers whose `source` is `local`, `user` or `project`, and it removes from that scope only. claude.ai connectors, plugin servers and anything else get no Remove.
- Claude Code's refusals are shown word for word (`MCP_FAILED`), after any header or environment value in them is replaced by `•••`.
- Copy, fixed here (spec mock plus plan-chosen where the spec is silent):
  - the dialog button is `+ Add server`;
  - the form title is `Add MCP server`;
  - fields: `Name`, `Type` with `URL (http)` / `Command (stdio)`, `URL`, `Command`, `Arguments (one per line)`, `Headers` / `Environment` with `+ add` and `(values hidden)`, `Who uses it`;
  - buttons `Cancel` / `Add`;
  - menu item `Remove`;
  - confirmation: title `Remove ‹name›?`, text `Claude Code on ‹machine› stops using it for ‹scope label›.`, button `Remove`;
  - the restart copy (only on the restart branch): `Added. It appears when this chat restarts between turns.` and `Removed. It disappears when this chat restarts between turns.`
- Run pnpm with `--config.verify-deps-before-run=false`, and don't reinstall node_modules. `@threadgarden/protocol` resolves via aliases. For Rust: `PATH="/c/Users/drnek/.rustup/toolchains/1.99.1-x86_64-pc-windows-msvc/bin:$PATH"` and `cargo.exe`. Commits carry no Claude attribution. Stay on `feat/mcp-add`, never push.

## Review Focus

1. **Claude Code's refusal repeats a value.** For example, invalid JSON echoed back, or a header in a URL error. The message reaches the UI with `•••` in its place, and nothing reaches the log. Task 5 test `a refusal that repeats a value is masked`.
2. **The status list carries the config.** `mcpServerStatus()` entries hold `config` (maybe with `headers` / `env`). `mcp.changed` must never carry them. Task 5 test `mcp.changed never carries header or environment values`.
3. **Adding during a turn.** The turn isn't interrupted and its status stays `working`. On the restart branch the restart waits for the turn, for open permission requests and for background tasks. Task 5 test `add during a turn doesn't interrupt it`; Task 4 tests.
4. **The add worked but the live chat couldn't pick it up.** A reconnect or restart failure after a successful `add-json` must not report the add as failed (a retry would say the name is taken). The row shows the server's own status instead. Task 5 test `a failure after adding doesn't fail the add`.
5. **`claude` missing, or hanging.** The machine has no located `claude` → `CLAUDE_MISSING` with the locator's words, not `INTERNAL`. A CLI that never exits (waiting on stdin or a prompt) → rejects after `MCP_CONFIG_TIMEOUT_MS = 30_000` with `Claude Code didn't answer in 30 s.` Task 3 tests `without claude it says CLAUDE_MISSING` and `a claude that never exits times out`.

---

### Task 1: Spike on the real CLI

**Files:**
- Create: `packages/service/test/real/mcp-config.real.test.ts` (opt-in, skipped unless `THREADGARDEN_REAL=1`, like `mcp.real.test.ts`; reuse its patterns: `findInstalledClaude`, `RealAdapter.start` with no prompt, `report` with the `[threadgarden-real]` prefix, `redact`, temp folders via `mkdtemp`, the cast to the session's `q`, and the `echo-mcp-server.mjs` fixture)
- Create: `docs/superpowers/specs/2026-11-24-mcp-add-server-spike-results.md`

**Interfaces:**
- Produces: the results doc, with a "Constants for the build" section that later tasks read:
  - `STDIN_WORKS: boolean`: `add-json <name> -` reads the JSON from stdin;
  - `ADD_SEEN_BY` and `REMOVE_SEEN_BY`, each `'status' | 'reconnect' | 'restart'`: the cheapest step after which a live session's `mcpServerStatus()` shows the change;
  - `SOURCE_OF_SCOPE`: the `source` / `scope` / `config.type` that a `local`, `user` and `project` server reports;
  - `VALUES_IN_STATUS`: whether status entries carry header or env values;
  - `EXIT`: the exit code and stream (stdout / stderr, with or without ANSI colour) of a success and of a refusal;
  - the exact texts `DUPLICATE_ERROR` (same name in the same scope, and what happens with the same name in another scope), `BAD_URL_ERROR` (`not a url` and `ftp://example.com`), `NOT_FOUND_ERROR` (remove from a scope that lacks the name), `BAD_JSON_ERROR` (does it echo the input?), and `NAME_RULE` (which of `a b`, `a.b`, `-x`, `ä`, `a_b-1` are accepted, plus the refusal text).

Run the CLI as the service will: `claudeInvocation` (Task 3) or the same logic inline, through `execFile` / `spawn`, with no shell and the temp folder as `cwd`. Server names are `tg-spike-<8 hex>`, unique per run.

- [ ] **Step 1: Write the checks** as `it` blocks:
  - `C1 add-json reads stdin`: add a stdio `echo` (the fixture through `process.execPath`) at `--scope local` with `-` and the JSON on stdin. Report the exit code, stdout and stderr, then `claude mcp get <name>` (redacted).
  - `C2 live add` (local, then `project`): open a session in the folder and wait until no server is `pending`. Add the server, then report its entry after:
    - (a) polling `mcpServerStatus()` for 10 s;
    - (b) `reconnectMcpServer(name)`, then status;
    - (c) a new process in the same folder (no resume: it has no transcript).
    For `project`, also report the keys of `<tmp>/.mcp.json`.
  - `C3 user scope`: the same as C2 with `--scope user`. In `afterAll`, `claude mcp remove --scope user <name>`, and report that `claude mcp get <name>` no longer finds it. This is the one write to the owner's real `~/.claude.json`, so the cleanup is mandatory.
  - `C4 live remove`: remove C2's local server. Report its entry after (a), (b) (and the reconnect's error, if any) and (c).
  - `C5 values`: add an http server `{ type: 'http', url: 'https://mcp.linear.app/mcp', headers: { 'X-Tg-Spike': 'SPIKE-SECRET-VALUE' } }` and a stdio server with `env: { TG_SPIKE: 'SPIKE-SECRET-VALUE' }`. Report whether `SPIKE-SECRET-VALUE` appears in the CLI's output, in `mcpServerStatus()` (the whole entry) or in `claude mcp list`. Report yes/no only, never the value.
  - `C6 refusals`: collect the texts listed in Interfaces, verbatim (redacted), with exit codes.
  - Cleanup: remove every `tg-spike-*` server from every scope it was added to, close the sessions, and remove the temp folders. Report any `~/.claude.json` project entries left behind (read only).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real mcp-config.real` and keep the output.
- [ ] **Step 3: Write the results doc** in the style of `2026-11-22-mcp-servers-spike-results.md`: the setup, a table with one row per check, findings, and "Constants for the build". If `ADD_SEEN_BY` or `REMOVE_SEEN_BY` is `'restart'`, say so at the top: Task 4 is then built, otherwise it's skipped. If `STDIN_WORKS` is false, stop and report before Task 2: the fallback (JSON in the arguments) breaks a spec rule, so the owner decides.
- [ ] **Step 4: Commit** `docs: spike results for adding MCP servers` (the test and the doc).

### Task 2: Protocol: `mcp.add`, `mcp.remove`, `mcp-config`

**Files:**
- Modify: `packages/protocol/src/mcp.ts`, `packages/protocol/src/methods.ts` (after `mcp.act`), `packages/protocol/src/version.ts` (extend the `12` line: `; mcp.add / mcp.remove behind the mcp-config capability`)
- Modify: `apps/desktop/src-tauri/core/src/methods.rs` (`"mcp.add"`, `"mcp.remove"` into `REFUSED` under the MCP comment), `packages/protocol/test/fixtures/core-answers/methods.json` (regenerated)
- Test: `packages/protocol/test/mcp.test.ts`

**Interfaces:**
- Produces (exported from `@threadgarden/protocol`):
  - `MCP_CONFIG_CAPABILITY = 'mcp-config'`;
  - `McpScopeSchema = z.enum(['local', 'user', 'project'])`, `type McpScope`;
  - `MCP_SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/`, or narrower if `NAME_RULE` says so (never wider: a leading `-` must stay impossible, since the name is an argument);
  - `McpServerConfigSchema`, `type McpServerConfig`:
    ```ts
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('http'), url: z.string().url(), headers: z.record(z.string().min(1), z.string()).optional() }),
      z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string().min(1), z.string()).optional() }),
    ])
    ```
  - `mcp.add { sessionId, name: z.string().regex(MCP_SERVER_NAME), scope: McpScopeSchema, config: McpServerConfigSchema } → { restartPending: boolean }`;
  - `mcp.remove { sessionId, name: z.string().min(1), scope: McpScopeSchema } → { restartPending: boolean }`;
  - Neither is `localOnly`. No new error codes: refusals are `MCP_FAILED`.

- [ ] **Step 1: Write the failing tests** in `mcp.test.ts`:
  - `MCP_CONFIG_CAPABILITY is 'mcp-config' and not in CAPABILITIES`;
  - `mcp.add and mcp.remove are listed and not localOnly`;
  - `mcp.add takes an http and a stdio server`: `{ type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer x' } }` and `{ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } }` parse, and the result `{ restartPending: false }` parses;
  - `mcp.add refuses a bad name, URL, scope or command`: names `''`, `'-x'`, `'a b'`; url `'nope'`; scope `'global'`; command `''`;
  - the existing `PROTOCOL_VERSION is 12 and the remote range is 11..13` stays green, unchanged.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol exec vitest run`. Expect FAIL (in `mcp.test.ts`, and in `core-contract.test.ts` once the methods exist).
- [ ] **Step 3: Implement** the protocol changes. Add the Rust entries, then in `apps/desktop/src-tauri/core` run `THREADGARDEN_WRITE_FIXTURES=1 cargo.exe test --test contract`.
- [ ] **Step 4: Run** the protocol tests and `cargo.exe test` in `apps/desktop/src-tauri/core`. Expect PASS.
- [ ] **Step 5: Commit** `feat(protocol): mcp.add and mcp.remove behind mcp-config`.

### Task 3: Running `claude mcp` on the machine

**Files:**
- Modify: `packages/service/src/sdk/claude-path.ts` (add `claudeInvocation`), `packages/service/src/external/poller.ts` (`makeClaudeRunner` uses it)
- Create: `packages/service/src/mcp/config.ts`
- Test: `packages/service/test/mcp/config.test.ts`, `packages/service/test/sdk/claude-path.test.ts`

**Interfaces:**
- Consumes: `McpScope`, `McpServerConfig` (Task 2); the Task 1 constants.
- Produces:
  - `claudeInvocation(claudePath: string, args: string[]): { cmd: string; argv: string[] }`: a `.js` / `.mjs` path runs with `process.execPath`, anything else directly (the rule `makeClaudeRunner` and the SDK already follow).
  - In `config.ts`:
    ```ts
    export const MCP_CONFIG_TIMEOUT_MS = 30_000;
    /** From the spike (2026-11-24-mcp-add-server-spike-results.md). */
    export const CONFIG_SEEN_BY: { add: 'status' | 'reconnect' | 'restart'; remove: 'status' | 'reconnect' | 'restart' };
    export interface McpConfig {
      add(o: { cwd: string; scope: McpScope; name: string; config: McpServerConfig }): Promise<void>;
      remove(o: { cwd: string; scope: McpScope; name: string }): Promise<void>;
    }
    export const addJsonArgs = (name: string, scope: McpScope): string[]; // ['mcp', 'add-json', '--scope', scope, name, '-']
    export const removeArgs = (name: string, scope: McpScope): string[];  // ['mcp', 'remove', '--scope', scope, name]
    export const maskValues = (text: string, config: McpServerConfig): string; // each non-empty header/env value → '•••'
    export const cliMcpConfig = (deps: {
      claude: () => Promise<{ path: string } | { detail: string }>; // waits for the locator
      env: () => Record<string, string | undefined>;
      timeoutMs?: number;
    }): McpConfig;
    ```
  - `cliMcpConfig` spawns without a shell (`windowsHide: true`), writes `JSON.stringify(config)` to stdin and ends it. It resolves on exit code 0. Otherwise it rejects with `new Error(text)`, where `text` is the stderr, else the stdout, trimmed and ANSI-stripped, else `` `claude mcp exited with ${code}` `` (adjust to `EXIT`). Without `claude` it throws `ServiceError('CLAUDE_MISSING', detail)`. On timeout it kills the process and rejects with `Claude Code didn't answer in 30 s.` It logs nothing.

- [ ] **Step 1: Write the failing tests.** `config.test.ts` uses a temp `fake-claude.mjs` as the path. The script appends `{ argv, cwd, stdin, env: { TG_PROBE } }` to a JSON-lines file, then behaves as its first stdin or argument byte says (exit 0; print to stderr and exit 1; never exit).
  - `add passes the JSON on stdin, never in the arguments`: argv equals `addJsonArgs('sentry', 'local')`, `JSON.parse(stdin)` equals the config, `argv.join(' ')` lacks `Bearer SECRET`, `cwd` is the given folder, and `TG_PROBE` from `env()` arrives;
  - `remove runs mcp remove with the scope`;
  - `a refusal rejects with Claude Code's words`: stderr `\x1b[31mMCP server sentry already exists in local config\x1b[0m` and exit 1 reject with exactly `MCP server sentry already exists in local config` (use `DUPLICATE_ERROR`'s shape);
  - `without claude it says CLAUDE_MISSING`;
  - `a claude that never exits times out` (`timeoutMs: 200`);
  - `maskValues hides every header and env value`: values `Bearer SECRET` and `k` in `x Bearer SECRET y` → `x ••• y`; an empty value is left alone;
  - `claude-path.test.ts`: `claudeInvocation runs scripts with node and binaries directly` (`/a/cli.js` → `{ cmd: process.execPath, argv: ['/a/cli.js', 'mcp'] }`; `C:\\x\\claude.exe` → itself).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/mcp/config.test.ts test/sdk/claude-path.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus `test/external/poller.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): run claude mcp add-json and remove`.

### Task 4: Restart between turns (only if the spike says `restart`)

Skip this task, and tick it as skipped, when both `CONFIG_SEEN_BY` values are `'status'` or `'reconnect'`. The MCP feature's earlier restart-in-place design was dropped, so this is new. Keep it to the one method below.

**Files:**
- Modify: `packages/service/src/chat/session-host.ts`
- Test: `packages/service/test/chat/session-host.test.ts`

**Interfaces:**
- Produces: `SessionHost.restartWhenIdle(sessionId: string): boolean`. It returns true when the process restarted now (live, `status === 'idle'`, no `pendingRequests()`, `runningTasks === 0`): `s.pause()`, then `this.ensureLive(sessionId, s.cwd)`, so the event log, choices and permissions carry over as after an idle reclaim. Otherwise it returns false and remembers the id. A remembered id is retried when that chat's turn ends (the host wraps `onTurnEnded`) and on every reclaim tick. It's forgotten on `end`, `stopAll` and when the chat stops being live. Pinned chats restart too (this isn't a reclaim).

- [ ] **Step 1: Write the failing tests** (FakeAdapter):
  - `restartWhenIdle restarts an idle chat with the same session id`: returns true; the adapter's newest start has `resume: id`; `host.get(id)!.live`;
  - `restartWhenIdle waits for the turn to end`: false while `working`, no new start; after the fake session's `result`, a start with `resume: id`;
  - `restartWhenIdle waits for permission requests and background tasks`;
  - `an ended chat is not restarted later`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/chat/session-host.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the chat tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): restart a chat's process between turns`.

### Task 5: The `mcp.add` / `mcp.remove` handlers and the capability

**Files:**
- Modify: `packages/service/src/server/handlers/mcp.ts`, `packages/service/src/main.ts`
- Test: `packages/service/test/server/mcp-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `registerMcpHandlers` deps gain `config: McpConfig` and `restart?: (sessionId: string) => boolean` (`host.restartWhenIdle`; required when either `CONFIG_SEEN_BY` value is `'restart'`).
  - `StartOptions.mcpConfig?: McpConfig`. The default is `cliMcpConfig({ claude, env: sessionEnvOf })`, where `claude` awaits `whenLocated()` and then returns `claude.current`, or `{ detail: 'Claude Code has not been located yet.' }` when that's still unset (the same words `chat.ts` uses).
  - `MCP_CONFIG_CAPABILITY` goes in both `capabilities` branches.

Behaviour of `mcp.add` (and `mcp.remove`, the same with `CONFIG_SEEN_BY.remove`):
1. `live(sessionId)`, as the other handlers: `MCP_UNSUPPORTED` for Codex, `NOT_LIVE` without a process.
2. `config.add({ cwd: s.cwd, scope, name, config })`. A `ServiceError` passes through. Any other failure becomes `ServiceError('MCP_FAILED', maskValues(message, config))`. Never `onError`.
3. Make the chat see it: `'status'` does nothing; `'reconnect'` calls `controls.reconnect(name)`; `'restart'` sets `restartPending = !deps.restart(sessionId)`. A failure in this step is swallowed: the add happened, and the row shows the server's own status. Nothing is logged (Claude Code's words).
4. `refresh(sessionId)`, then answer `{ restartPending }` (always `false` off the restart branch).

- [ ] **Step 1: Write the failing tests**, with a fake `McpConfig` passed as `mcpConfig`. The fake records calls, can be told to reject, and on success pushes `{ name, status: 'connected', source: scope, scope, config: { ...config } }` into the fake session's `mcpServers` (or removes it from them).
  - `add runs in the chat's folder with the chosen scope`;
  - `add refuses a Codex chat and a chat that isn't running`;
  - `add shows Claude Code's refusal as is` (`MCP_FAILED`, the message unchanged);
  - `a refusal that repeats a value is masked`: the rejection `bad header Bearer SECRET` answers `bad header •••`, and neither the logger nor `onError` saw `SECRET`;
  - `mcp.changed never carries header or environment values`: after an add with `headers: { A: 'SECRET' }`, no emitted event's JSON contains `SECRET`;
  - `the added server appears in the list` (`mcp.list` has it, with `source` equal to the scope);
  - only on the reconnect branch: `add reconnects the new server in this chat`;
  - only on the restart branch: `add restarts an idle chat` (`restartPending: false`), `add during a turn says restartPending` (`true`);
  - `a failure after adding doesn't fail the add` (the reconnect rejects, or the restart throws): it answers normally;
  - `add during a turn doesn't interrupt it` (no interrupt recorded, status stays `working`);
  - `remove runs claude mcp remove with the row's scope`, and `remove shows Claude Code's refusal as is`;
  - `hello advertises mcp-config, local and headless`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/server/mcp-handlers.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Update the handler file's doc comment: header and env values only reach `config.add`.
- [ ] **Step 4: Run** the whole service suite and the service typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): mcp.add and mcp.remove`.

### Task 6: Fake add and remove in the mock

**Files:**
- Modify: `packages/service/src/testing/mock-main.ts` (a `MockMcpConfig` passed as `mcpConfig`; `ScriptedSession.mcp.status()` merges it; `mock.mcpReset` resets it; the file comment)
- Test: `packages/service/test/testing/mock-main.test.ts`

**Interfaces:**
- Produces: `class MockMcpConfig implements McpConfig`, held by `ScriptedAdapter` so sessions can read it:
  - `add` records `{ cwd, scope, name, type }`. A name already listed in that chat's servers (fixed or added) for that scope rejects with `DUPLICATE_ERROR`'s text. `user` scope is seen by every chat; `local` and `project` only by chats in that `cwd`.
  - `remove` drops an added server, or hides a fixed one whose `source` is the scope (`github` user, `mock-off` local, `mock-etoro` project). Anything else rejects with `NOT_FOUND_ERROR`'s text.
  - An added server reports `source` and `scope` = its scope (per `SOURCE_OF_SCOPE`). `http` reports `needs-auth` with `config.type: 'http'`, so it signs in like `mock-oauth`. `stdio` reports `connected`.
  - It shows at once, whatever `CONFIG_SEEN_BY` says: the handler's path is covered in Task 5, and on the restart branch the mock's idle chats restart at once.
  - `reset()` forgets every add and remove; `mock.mcpReset` calls it.

- [ ] **Step 1: Write the failing tests:**
  - `adding a server lists it in this chat` (http → `needs-auth`, `source: 'local'`);
  - `a user server shows in every chat, a local one only in its folder`;
  - `a taken name is refused in Claude Code's words` (`github`, `user`);
  - `removing mock-off takes it off the list`;
  - `mock.mcpReset forgets added and removed servers`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/testing/mock-main.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the service suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(mock): fake adding and removing MCP servers`.

### Task 7: The add form, its helpers and `ChatMcp`

**Files:**
- Modify: `apps/desktop/src/lib/components/chat/mcp.ts`, `apps/desktop/src/lib/state/mcp.svelte.ts`, `apps/desktop/src/lib/projects.ts`
- Create: `apps/desktop/src/lib/components/chat/McpAddServerForm.svelte`
- Test: `apps/desktop/tests/chat/mcp.test.ts`, `apps/desktop/tests/chat/mcp-add-form.test.ts`

**Interfaces:**
- Consumes: the Task 2 exports.
- Produces:
  - `projects.ts`: `supportsMcpConfig(m: MachineEntry | undefined): boolean` (has `MCP_CONFIG_CAPABILITY`).
  - `ChatMcp`:
    - `add(name: string, scope: McpScope, config: McpServerConfig): Promise<{ restartPending: boolean }>`;
    - `remove(name: string, scope: McpScope): Promise<{ restartPending: boolean }>`.
    Both send the request, then `quietly(this.load())`.
  - `mcp.ts`:
    ```ts
    export type AddForm = { name: string; type: 'http' | 'stdio'; url: string; command: string;
      args: string; pairs: { key: string; value: string }[]; scope: McpScope };
    export const emptyAddForm = (): AddForm; // type 'http', scope 'local', no pairs
    export const SCOPE_LABELS: Record<McpScope, string>; // the Global Constraints labels
    export const PROJECT_SCOPE_NOTE: string;
    export const validateAddForm = (f: AddForm): string | null; // the first problem, or null
    export const toServerConfig = (f: AddForm): McpServerConfig;
    export const removeScope = (s: McpServer): McpScope | null; // s.source if local|user|project
    export const removeText = (machine: string, scope: McpScope): string;
    export const ADDED_AFTER_RESTART = 'Added. It appears when this chat restarts between turns.';
    export const REMOVED_AFTER_RESTART = 'Removed. It disappears when this chat restarts between turns.';
    ```
    - `validateAddForm` messages, checked in this order:
      - `Use letters, numbers, - and _ for the name (not starting with -).` (fails `MCP_SERVER_NAME`, after trimming);
      - `Enter a full address starting with https:// or http://.`;
      - `Enter the command to run.`;
      - `Give every header a name.`, or for stdio `Environment names use letters, numbers and _, not starting with a number.` (`/^[A-Za-z_][A-Za-z0-9_]*$/`), for a pair with a value but no valid key. A pair whose key and value are both blank is ignored.
    - `toServerConfig`: trim name, URL and command. `args` is one per line: drop blank lines, strip a trailing `\r`, otherwise keep as typed. `headers` / `env` come from the kept pairs, and an empty `headers` / `env` / `args` is omitted.
  - `McpAddServerForm.svelte` props `{ onAdd: (name: string, scope: McpScope, config: McpServerConfig) => Promise<void>; onCancel: () => void }`. It renders the spec's form with the Global Constraints copy: value inputs `type="password"`, the note under *Everyone*, the problem or Claude Code's refusal under the buttons in a `role="alert"`, and the values kept on a refusal.

- [ ] **Step 1: Write the failing tests.**
  - `mcp.test.ts`:
    - `validateAddForm accepts a good http and stdio server`;
    - `validateAddForm names the first problem`: names `' '`, `'-x'`, `'a b'`; URL `''` and `'ftp://x'`; command `''`; header `{ key: '', value: 'v' }`; env key `'1X'`; each gives its message;
    - `toServerConfig builds the JSON Claude Code takes`: http `{ type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer x' } }`; stdio args `'-y\r\n\npkg'` → `['-y', 'pkg']`, `env` kept; no empty `headers` / `env` / `args` keys;
    - `removeScope is the source for local, user and project, null otherwise` (`claudeai`, `plugin`, `managed`, `''`);
    - `ChatMcp add and remove send the scope and reload` (fake Api: `mcp.add` params, then an `mcp.list`).
  - `mcp-add-form.test.ts`:
    - `the type switches between the URL and the command fields`;
    - `header and environment values are masked`;
    - `Everyone shows the .mcp.json note`;
    - `Add sends the server` (`onAdd('sentry', 'local', { type: 'http', url: … })`);
    - `a problem is shown and nothing is sent`;
    - `Claude Code's refusal is shown word for word and the form keeps its values`;
    - `Cancel calls onCancel`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/chat/mcp.test.ts tests/chat/mcp-add-form.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, the desktop typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): the add MCP server form`.

### Task 8: Add server and Remove in the dialog

**Files:**
- Modify: `apps/desktop/src/lib/components/chat/McpServersDialog.svelte`, `apps/desktop/src/lib/components/chat/mcp.ts` (`MenuAction` gains `'remove'`), `apps/desktop/src/lib/components/chat/ChatView.svelte` (pass `canConfigure={supportsMcpConfig(entry)}`)
- Test: `apps/desktop/tests/chat/mcp-dialog.test.ts` (add `add` / `remove` to `fakeMcp`), `apps/desktop/tests/chat/mcp-banner.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces:
  - `McpServersDialog` gets the prop `canConfigure: boolean`.
  - When it's true and the chat is live, the header shows `+ Add server`, which swaps the list for `McpAddServerForm` (titled `Add MCP server`). A successful add returns to the list, and shows `ADDED_AFTER_RESTART` above it when `restartPending`.
  - The row's menu is `[...menuActions(s), ...(canConfigure && removeScope(s) ? ['remove'] : [])]`. The menu now also shows for `unapproved` and `disabled` rows when Remove is their only item.
  - `Remove` opens `ConfirmDialog` (destructive): title `Remove ‹name›?`, description `removeText(machineName, scope)`, confirm label `Remove`. Confirming calls `mcp.remove(name, scope)`. A refusal shows in the confirm dialog (its own error display). With `restartPending` it shows `REMOVED_AFTER_RESTART` above the list.
  - The new lines (`ADDED_AFTER_RESTART`, `REMOVED_AFTER_RESTART`) clear when the dialog closes, like the dialog's other state.

- [ ] **Step 1: Write the failing tests.**
  - `mcp-dialog.test.ts`:
    - `Add server opens the form and an add returns to the list`;
    - `no Add server without mcp-config or when the chat isn't running`;
    - `restartPending says when the server appears` (exact copy);
    - `Remove is in the menu for local, user and project servers only` (rows `project`, `user`, `local` with Remove; `claudeai`, `plugin` without);
    - `Remove asks first, naming the server and the scope, then removes from that scope` (the text holds `Ubuntu PC` and `Me, every project` for a `user` row; `remove('a', 'user')` is called only after the confirm);
    - `a refused remove shows Claude Code's words`.
  - `mcp-banner.test.ts`: `Add server only on a machine with mcp-config` (capabilities `['remote', MCP_CAPABILITY]` vs. `[…, MCP_CONFIG_CAPABILITY]`).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/chat/mcp`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole desktop suite, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): add and remove MCP servers in the dialog`.

### Task 9: End to end, docs, wrap-up

**Files:**
- Modify: `apps/desktop/e2e/mcp.spec.ts`, `apps/desktop/e2e/phone.spec.ts`, `docs/architecture.md` (the MCP paragraph), `README.md` (the MCP feature line)

- [ ] **Step 1: Write the e2e tests** against the mock (`mock.mcpReset` is already in `beforeEach`), in `mcp.spec.ts`:
  - `add an http server; it appears and offers Sign in`: in `LIVE_CHAT`, name `mock-added`, URL `https://mcp.example.test/mcp`, header `Authorization` / `Bearer E2E-SECRET`. Afterwards the row reads `local` and `Needs sign-in`, and `page.content()` lacks `E2E-SECRET`;
  - `add a stdio server with arguments and environment` (row `Connected`);
  - `a taken name shows Claude Code's words` (`github`, `Me, every project`);
  - `remove asks first, then the row goes` (`mock-off`);
  - `no Remove for claude.ai and plugin servers` (`mock-notion`, `context7`);
  - `add on the remote mock` (paired, `REMOTE_CHAT`).
  - In `phone.spec.ts`, extend the MCP check: `+ Add server` is visible in the phone layout.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop test:e2e mcp phone` (if Chromium is installed). Expect PASS. On Windows, re-run once a run stuck at `openApp` (known flake).
- [ ] **Step 3: Write the docs.** In `architecture.md`, add to the MCP paragraph: Add / Remove run Claude Code's own CLI (`mcp add-json … -` with the JSON on stdin, `mcp remove`) with the SDK's `claude`, in the chat's folder; the scopes; how the live chat picks the change up (per the spike); the `mcp-config` capability; values never logged. In `README.md`, extend the MCP line with "add and remove servers".
- [ ] **Step 4: Run** the full protocol, service and desktop suites, and `cargo.exe test` in `apps/desktop/src-tauri/core`. Expect PASS.
- [ ] **Step 5: Commit** `docs: adding and removing MCP servers`.
- [ ] **Step 6: Hardware check with the owner** (when kumbal is free; with the MCP feature's postponed check if that's still open). On kumbal and on This PC, from the desktop and the phone: add an http server with a header, sign in, remove it; add a stdio server in each scope; confirm with `claude mcp list` on the machine; check that `ps` on kumbal never shows the header. Record the result in the spike results doc's last section.
- [ ] **Step 7: Update the vault.** `git pull` in the vault, then mark "Add MCP servers from the dialog" done in the matching `Threadgarden/` note (keep the catalog idea under *To decide*). Commit and push the vault. Don't push this repo: the controller merges it with `feat/mcp-servers`.

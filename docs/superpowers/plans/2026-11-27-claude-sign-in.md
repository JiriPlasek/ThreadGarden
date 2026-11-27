# Sign in to Claude from Threadgarden: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings shows each machine's Claude account with **Sign in** / **Switch account**. A sign-in runs on that machine through Claude Code's own login, with the link opened anywhere and the code pasted back. A chat that fails on login offers **Sign in to Claude**, and `/login` opens the same flow. It works the same from the desktop and the phone.

**Architecture:**
- The SDK's undeclared login controls (`claudeAuthenticate`, `claudeOAuthCallback`, `claudeOAuthWaitForCompletion`) are wrapped once as `AgentSession.login`.
- A new `packages/service/src/claude-login/` module keeps one machine's account state: the account last reported, a "sign-in expired" flag, and at most one sign-in in progress. It runs the sign-in on a live Claude chat's process, or on a short-lived process started just for it. After a success, it restarts that machine's live Claude chats between turns.
- New `claude.*` methods and a `claude.account` event (protocol 14, capability `claude-login`) carry it to the UI. The UI adds a Settings section, a sign-in dialog, a button on the login-failure line, and a `/login` intercept.

**Tech Stack:** TypeScript, zod (protocol), Node 22 service, Agent SDK 0.3.314 / Claude Code 2.1.318, Svelte 5 + Tailwind (desktop/phone UI), Rust (phone core constants), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-claude-sign-in-design.md`

## Global Constraints

- **Scope.**
  - The claude.ai login only (`claudeAuthenticate(true)`). No Console login, no gateway login, no sign out.
  - Codex chats get no button, and `/login` is not intercepted for them.
- **No writing Claude Code's files.** Threadgarden never writes Claude Code's login or config files. Claude Code's sign-in does the writing.
- **No logging secrets.** The pasted code, the sign-in link and the `state` are never stored or logged. They never go into `claude.account`, the database, `ui.error`, a chat item or the service log. They pass through method params and results only.
- **Machines on an API key.** A machine whose account is an API key (`UsageAccount.kind === 'apiKey'`) or a third-party provider (`'provider'`) gets no sign-in. Its row says `Uses an API key` / `Uses ‹provider›`.
- **One sign-in at a time per machine.** Starting a second one cancels the first.
- **The restart after a sign-in.**
  - It is `SessionHost.restartWhenIdle`, with its waits, for every live Claude chat on the machine.
  - The exception is chats whose last turn failed on login. Those restart without waiting for running tasks or a `/loop` timer.
  - Never during a turn, and never with an open request.
- **Protocol:**
  - `PROTOCOL_VERSION = 14`, `REMOTE_PROTOCOL_RANGE = { min: 13, max: 15 }`.
  - Capability `'claude-login'` (`CLAUDE_LOGIN_CAPABILITY`), added at runtime like `mcp`.
  - A machine without it shows its row with no buttons, plus `Update this machine to sign in from here.`
- **The undeclared SDK methods** live in one typed wrapper in `real-adapter.ts`, next to `McpUndeclared`, with the note "recheck on every SDK update".
- **Copy, fixed here:**
  - Settings section: `Claude accounts`.
  - Row states:
    - `‹email› · ‹plan›` (email alone if there's no plan)
    - `Sign-in expired`
    - `Not known yet`
    - `Uses an API key`
    - `Uses ‹provider›`
  - Buttons: `Sign in`, `Switch account`.
  - Dialog:
    - Title: `Sign in to Claude (‹machine›)`.
    - Step 1: `Open this link and approve:` with `Copy` and `Open`.
    - Step 2 field label: `Paste the code claude.ai shows you`.
    - Buttons: `Cancel`, `Sign in`.
    - Success: `Signed in as ‹email›.`
  - Failure line in a chat: `Claude Code isn't signed in on ‹machine›, or its sign-in expired.`, with the button `Sign in to Claude`.
  - Restart note: `Restarted after signing in. Start /loop again if you need it.`
- **Tooling.** Run pnpm with `--config.verify-deps-before-run=false`, and don't reinstall node_modules (the no-links recipe). Commits carry no Claude attribution. Run the full e2e locally (shifted `THREADGARDEN_E2E_*` ports) before any push.

## Review Focus

1. **The pasted code isn't clean.** Spaces, a trailing newline, or the whole `code#state` string the page shows are trimmed. The `#state` part is split off when the spike shows Claude Code expects code and state apart. A wrong code comes back as `LOGIN_FAILED` in Claude Code's words, and the dialog stays open for another try. Task 5 tests `a pasted code with spaces and a newline signs in` and `a wrong code keeps the sign-in open`.
2. **A secret in an error.** An SDK error that quotes the code or the link goes back to the caller only, and never into the log. Task 5 test `never logs the code or the link`.
3. **The dialog closes mid-way** (Cancel, Escape, the phone's Back). The sign-in is cancelled and its short-lived process closed. A later **Sign in** starts fresh. Task 5 test `cancel closes the helper process`; Task 7 test `Back on the phone cancels the sign-in`.
4. **A switch during a running turn.** Nothing is interrupted. That chat restarts after its turn, and other chats restart as they become free. Task 5 test `a sign-in during a turn restarts that chat only after it`.
5. **The phone's sign-in goes through the relay to wobble.** The link opens in the phone's browser and the code is typed on the phone. The machine's name in the dialog is the paired machine's. Task 8 phone e2e `signs in a paired machine from the phone`.

---

### Task 1: Spike on the real CLI

**Files:**
- Create: `packages/service/test/real/claude-login.real.test.ts` (opt-in; kept as the "recheck on every SDK update" check)
- Create: `docs/superpowers/specs/2026-11-27-claude-sign-in-spike-results.md`

**Interfaces:**
- Produces: the results doc's "Constants for the build" section. Later tasks read these values:
  - `AUTH_START`: what `claudeAuthenticate(true)` returns (JSON shape; which key holds the manual link, whether there is also an automatic one).
  - `CODE_SHAPE`: what claude.ai shows to paste (`code#state` or `code`), and what `claudeOAuthCallback(authorizationCode, state)` needs.
  - `WAIT_RESULT`: what `claudeOAuthWaitForCompletion()` resolves or rejects with, on success and after a wrong code.
  - `WORKS_WHEN_EXPIRED`: whether the controls work in a process started with no login, or with a dead one.
  - `ACCOUNT_AFTER`: whether `accountInfo()` in the same process shows the new account, and whether `auth_status` messages arrive (their `output`).
  - `OTHERS_PICK_UP`: whether another process that was already running uses the new login on its next turn, or needs a restart.

Every check runs with `CLAUDE_CONFIG_DIR` set to a fresh temp folder, so Claude Code starts not signed in. The owner's real login is never touched. Use `RealAdapter`, send no prompt except where named, and prefix report lines with `[threadgarden-real]`. Never print the code or the full link. Print the link's host and path only, and the shape of the JSON (its keys).

- [ ] **Step 1: Write the checks** as `it` blocks, skipped unless `THREADGARDEN_REAL=1`:
  - `L1 start`: `claudeAuthenticate(true)`, report its key names and the link's host/path.
  - `L2 wrong code`: `claudeOAuthCallback('wrong', <state from L1>)`, report the error verbatim with any code redacted, then `claudeOAuthWaitForCompletion()` with a 10 s timeout.
  - `L3 no login`: send `hi` in the temp config dir and report the result's error and every `auth_status` seen.
  - `L4 complete (manual, owner present)`: only with `THREADGARDEN_REAL_LOGIN=1`. Print the full link to the terminal (not into the report file), read the pasted code from stdin, then call `claudeOAuthCallback` and `claudeOAuthWaitForCompletion`. Report `accountInfo()` (email domain only), an `auth_status` count, and whether a second process started before L4 answers `hi` afterwards (`OTHERS_PICK_UP`).
  - Cleanup: delete the temp config dir.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real -- claude-login`, then L4 with the owner. Keep the output.
- [ ] **Step 3: Write the results doc** in the style of `2026-11-22-mcp-servers-spike-results.md`: setup, one table row per check, the findings that change the design, and "Constants for the build". If L1/L2 show the controls don't work, stop and report: the owner decides on the PTY fallback.
- [ ] **Step 4: Commit** `docs: Claude sign-in spike results`.

### Task 2: Protocol 14

**Files:**
- Create: `packages/protocol/src/claude-login.ts`, `packages/protocol/test/claude-login.test.ts`
- Modify:
  - `packages/protocol/src/{methods,events,version,index}.ts`;
  - the version and range pins in `packages/protocol/test/*.test.ts` and `packages/protocol/test/fixtures/protocol-range.json`;
  - `apps/desktop/tests/state/machines.test.ts`;
  - `apps/desktop/src-tauri/src/service.rs` (`PROTOCOL_VERSION: u32 = 14`);
  - `apps/desktop/src-tauri/core/src/lib.rs` (`14`, `(13, 15)`);
  - `apps/desktop/src-tauri/core/src/methods.rs` (the new methods into `REFUSED`);
  - `packages/protocol/test/fixtures/core-answers/*` (regenerated).

**Interfaces:**
- Produces:
  - `CLAUDE_LOGIN_CAPABILITY = 'claude-login'`.
  - `ClaudeAccountSchema = z.object({ account: UsageAccountSchema.nullable(), expired: z.boolean(), signingIn: z.boolean() })`. `account` null means "Not known yet". The type is `ClaudeAccount`.
  - Methods (none `localOnly`):
    - `claude.account {} → ClaudeAccount`;
    - `claude.signIn { sessionId?: string } → { url: string }`. The optional `sessionId` runs it on that chat's process;
    - `claude.signInCode { code: z.string().min(1).max(4096) } → { account: UsageAccount | null }`;
    - `claude.signInCancel {} → {}`.
  - Event `'claude.account': ClaudeAccountSchema`.
  - Error codes (`CLAUDE_LOGIN_ERRORS`): `LOGIN_FAILED` (Claude Code's words), `LOGIN_NOT_STARTED` (a code without a sign-in), `LOGIN_UNSUPPORTED` (the machine uses an API key or a provider).

- [ ] **Step 1: Write the failing tests** in `claude-login.test.ts`:
  - `PROTOCOL_VERSION is 14 and the remote range is 13..15`;
  - `CLAUDE_LOGIN_CAPABILITY is 'claude-login' and not in CAPABILITIES`;
  - `claude.* methods and the claude.account event are listed`;
  - `claude.signInCode refuses an empty code`.

  Also update the old pins (12..14 → 13..15, 13 → 14) and the fixture's samples.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol exec vitest run`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `version.ts` gets the line `14 — Sign in to Claude: claude.account, claude.signIn, claude.signInCode, claude.signInCancel, the claude.account event, the claude-login capability.`
  - Add the Rust constants and the `REFUSED` entries.
  - Regenerate the core's answers with `THREADGARDEN_WRITE_FIXTURES=1 cargo test --test contract` in `apps/desktop/src-tauri/core`.
- [ ] **Step 4: Run** the protocol tests, `cargo test` in `apps/desktop/src-tauri/core`, `cargo test protocol_version` in `apps/desktop/src-tauri`, and `apps/desktop/tests/state/machines.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(protocol): protocol 14 for signing in to Claude`.

### Task 3: Login controls on the session

**Files:**
- Modify:
  - `packages/service/src/sdk/adapter.ts` (`LoginControls`, `AgentSession.login?`);
  - `packages/service/src/sdk/real-adapter.ts` (`LoginUndeclared` beside `McpUndeclared`, `RealSession.login`);
  - `packages/service/src/testing/fake-adapter.ts`.
- Test: `packages/service/test/sdk/real-adapter.test.ts`, `packages/service/test/testing/fake-adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LoginControls {
    start(): Promise<unknown>;                              // claude_authenticate, loginWithClaudeAi: true
    submit(code: string, state: string): Promise<unknown>;  // claude_oauth_callback
    wait(): Promise<unknown>;                               // claude_oauth_wait_for_completion
  }
  ```
  - `AgentSession` gains `readonly login?: LoginControls`. Claude sessions have it; Codex sessions don't.
  - `FakeSession` gains `loginCalls: { op: string; arg?: unknown }[]`, `loginStart: unknown`, `loginError: Error | undefined`, `loginWaitResult: unknown`, and `accountAfterLogin: AccountInfo | undefined`. When `accountAfterLogin` is set, a successful `wait()` makes `accountInfo()` answer it.

- [ ] **Step 1: Write the failing tests.**
  - `real-adapter.test.ts` `forwards login controls to the query`: `start()` calls `claudeAuthenticate(true)`, `submit('c','s')` calls `claudeOAuthCallback('c','s')`, and `wait()` calls `claudeOAuthWaitForCompletion()`.
  - `fake-adapter.test.ts` `records login calls and rejects with loginError`.
- [ ] **Step 2: Run** those two files. Expect FAIL.
- [ ] **Step 3: Implement** `LoginUndeclared`, with the doc comment naming SDK 0.3.314 / Claude Code 2.1.318 and "recheck on every SDK update".
- [ ] **Step 4: Run** the same tests and the service typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): Claude login controls on a session`.

### Task 4: Recognise a login failure in a chat

**Files:**
- Modify: `packages/service/src/chat/live-session.ts`, `packages/service/src/chat/session-host.ts`
- Test: `packages/service/test/chat/live-session.test.ts`

**Interfaces:**
- Consumes: the spike's `L3` (which result/error/`auth_status` shape a failed login gives).
- Produces:
  - A failed login becomes the system item `{ kind: 'system', level: 'error', text: "Claude Code isn't signed in on ‹machine›, or its sign-in expired.", signIn: true }`, replacing the raw "Failed to authenticate…" line. Add `signIn?: true` to the system item schema in `packages/protocol/src/items.ts` (or wherever `setup?: true` lives), next to `setup`.
  - `LiveSession.failedOnLogin: boolean`. It is true from such a failure until the next turn that works.
  - `LiveSessionOptions.onLogin?(id: string, ok: boolean)`. It is called with `false` on a login failure and `true` on the first working turn after one.
  - `LiveSessionOptions.machineName: () => string`.

- [ ] **Step 1: Write the failing tests:**
  - `a login failure shows the sign-in line, not the raw error`, with the spike's exact message as input;
  - `failedOnLogin clears on the next working turn`;
  - `onLogin reports false then true`;
  - `other errors are unchanged` (a rate limit, a startup failure).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/chat/live-session.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the recognition as one function `isLoginFailure(m: SDKMessage): boolean` in `live-session.ts`, matching what L3 found.
- [ ] **Step 4: Run** the service suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): a chat that fails on login says so and offers sign-in`.

### Task 5: The machine's Claude account and the sign-in

**Files:**
- Create: `packages/service/src/claude-login/login.ts`, `packages/service/src/server/handlers/claude-login.ts`
- Modify:
  - `packages/service/src/main.ts` (wiring, the capability);
  - `packages/service/src/chat/session-host.ts` (`restartAfterSignIn`);
  - `packages/service/src/usage/usage.ts` (read the stored account; no behaviour change).
- Test: `packages/service/test/claude-login/login.test.ts`, `packages/service/test/server/claude-login-handlers.test.ts`, `packages/service/test/chat/session-host.test.ts`

**Interfaces:**
- Consumes: `LoginControls` (Task 3), `failedOnLogin` / `onLogin` (Task 4), and the spike's `AUTH_START`, `CODE_SHAPE`, `WAIT_RESULT`, `ACCOUNT_AFTER`, `OTHERS_PICK_UP`.
- Produces:
  ```ts
  export class ClaudeLogin {
    constructor(deps: {
      account: () => UsageAccount | null;       // usage's stored account
      liveClaude: () => LiveSession[];          // this machine's live Claude chats
      startHelper: () => Promise<AgentSession>; // short-lived process in the home dir, no prompt
      restartAfterSignIn: () => void;
      emit: (s: ClaudeAccount) => void;
      now: () => number;
    });
    state(): ClaudeAccount;
    noteLogin(ok: boolean): void;              // from onLogin
    start(sessionId?: string): Promise<{ url: string }>;
    submit(code: string): Promise<{ account: UsageAccount | null }>;
    cancel(): Promise<void>;
  }
  ```
  - `SessionHost.restartAfterSignIn(): void` runs `restartWhenIdle` on every live Claude chat. For chats with `failedOnLogin`, it skips the running-task and `/loop` waits. Each such chat whose `/loop` timer was dropped gets the restart note item. If the spike found `OTHERS_PICK_UP` true, `restartAfterSignIn` is a no-op except for chats with `failedOnLogin`.
  - The handlers register `claude.*`. A Codex `sessionId` or an API-key machine gets `LOGIN_UNSUPPORTED`.

- [ ] **Step 1: Write the failing tests** (`login.test.ts`, with `FakeSession`):
  - `start runs on the named chat's process when it is live, else on a helper`;
  - `a second start cancels the first`;
  - `a pasted code with spaces and a newline signs in` (and `code#state` per `CODE_SHAPE`);
  - `a wrong code keeps the sign-in open` (`LOGIN_FAILED`, `signingIn` stays true);
  - `cancel closes the helper process`;
  - `success emits the new account, clears expired, and restarts`;
  - `noteLogin(false) marks expired; noteLogin(true) clears it`;
  - `never logs the code or the link` (the report/log spy never sees them, even when the SDK error quotes them);
  - `an API-key machine refuses start`.

  In `session-host.test.ts`:
  - `restartAfterSignIn waits for a turn but not for a /loop in a chat that failed on login`;
  - `a sign-in during a turn restarts that chat only after it`.

  In `claude-login-handlers.test.ts`, one test per method, plus `LOGIN_NOT_STARTED`.
- [ ] **Step 2: Run** the three files. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The helper process: `adapter.start` with `cwd: os.homedir()`, no prompt, closed on cancel, on success and on a 10-minute timeout.
  - Wire `onLogin` → `noteLogin`, `onAccount` → emit, and the capability `claude-login` beside `mcp`.
- [ ] **Step 4: Run** the service suite, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): sign in to Claude on a machine`.

### Task 6: The mock's fake sign-in

**Files:**
- Modify: `packages/service/src/testing/mock-main.ts`
- Test: `packages/service/test/testing/mock-main.test.ts`

**Interfaces:**
- Produces:
  - The mock has the capability.
  - `claude.account` starts as `{ account: { kind: 'login', email: 'mock@example.com', plan: 'max' }, expired: false, signingIn: false }`. The remote mock starts as `expired: true`, and its chat `session-19`'s next turn fails with the sign-in line.
  - `claude.signIn` returns `{ url: 'https://claude.ai/oauth/authorize?mock=1' }`.
  - `claude.signInCode` accepts `MOCK-CODE` (signs in as `other@example.com`, plan `pro`) and rejects anything else with `LOGIN_FAILED` `Invalid code`.

- [ ] **Step 1: Write the failing tests:**
  - `the mock signs in with MOCK-CODE and refuses another`;
  - `the remote mock starts expired and session-19 fails on login`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the mock tests. Expect PASS.
- [ ] **Step 5: Commit** `test(mock): a fake Claude sign-in`.

### Task 7: Settings, the dialog, the chat button and `/login`

**Files:**
- Create:
  - `apps/desktop/src/lib/state/claude-accounts.svelte.ts`;
  - `apps/desktop/src/lib/components/ClaudeAccountsSettings.svelte`;
  - `apps/desktop/src/lib/components/ClaudeSignInDialog.svelte`.
- Modify:
  - `apps/desktop/src/lib/components/SettingsDialog.svelte` (the section, after Machines);
  - the system item component that renders `setup` (add the `signIn` button);
  - `apps/desktop/src/lib/components/composer/commands.ts` (`login` in `ALWAYS_LOCAL`, a `login` control);
  - `ChatView.svelte` (opens the dialog for the chat's machine);
  - `apps/desktop/src/lib/projects.ts` (`supportsClaudeLogin`).
- Test: `apps/desktop/tests/state/claude-accounts.test.ts`, `apps/desktop/tests/components/claude-sign-in-dialog.test.ts`, `apps/desktop/tests/components/claude-accounts-settings.test.ts`, the commands test

**Interfaces:**
- Consumes: protocol 14 (Task 2).
- Produces:
  - `class ClaudeAccounts`, keyed by machine id (`'local'` for This PC). It has `get(id): ClaudeAccount | undefined`, `refresh(id)`, `signIn(id, sessionId?): Promise<string>` (the url), `submit(id, code): Promise<UsageAccount | null>` and `cancel(id)`. It listens to `claude.account` on each machine's client.
  - `ClaudeSignInDialog` props: `{ machineId, machineName, sessionId?, open = $bindable() }`.

- [ ] **Step 1: Write the failing tests:**
  - The rows show each copy state of the Global Constraints, including `Uses an API key`, and the older-machine text without buttons.
  - The dialog:
    - shows the link with `Copy` and `Open`;
    - `Sign in` is disabled until a code is typed;
    - a `LOGIN_FAILED` answer shows Claude Code's words and keeps the dialog open;
    - success shows `Signed in as ‹email›.` and closes;
    - Cancel calls `cancel`.
  - `Back on the phone cancels the sign-in` (the dialog's close path calls `cancel`).
  - `/login is intercepted for a Claude chat and not for a Codex chat`.
  - `the sign-in line's button opens the dialog for that chat's machine`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run` on those files. Expect FAIL.
- [ ] **Step 3: Implement.** Follow `McpServersDialog.svelte` for the dialog's look and the phone layout.
- [ ] **Step 4: Run** the desktop suite, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): Claude accounts in Settings and the sign-in dialog`.

### Task 8: End to end, docs, wrap-up

**Files:**
- Create: `apps/desktop/e2e/claude-login.spec.ts`
- Modify:
  - `apps/desktop/e2e/phone.spec.ts`;
  - `README.md` and `docs/architecture.md` (the feature and protocol 14);
  - the vault (`Threadgarden.md` Now; done by the controller).

- [ ] **Step 1: Write the e2e tests:**
  - `Settings shows This PC's account and switches it with the mock code`;
  - `a paired machine's expired chat offers Sign in to Claude, and signing in lets it answer` (the remote mock's `session-19`);
  - `/login opens the sign-in`;
  - in `phone.spec.ts`, `signs in a paired machine from the phone`.

  All of them leave the mocks as they found them (sign back in as `mock@example.com` where the mock allows, or reset in `finally`).
- [ ] **Step 2: Run** the full e2e locally on shifted ports. Expect PASS.
- [ ] **Step 3: Docs.** One README feature line and an architecture section (the methods, the helper process, the restart rule).
- [ ] **Step 4: Hardware check with the owner:**
  - sign in wobble from Settings;
  - switch This PC's account and back;
  - check that a chat failing on login shows the button;
  - try `/login` on the phone.
- [ ] **Step 5: Commit** `test(e2e): signing in to Claude`, then open the PR and run the 0.12.1 release (version bump PR, tag).

---

## Amendment (owner, 2026-11-27): no Settings section, add `/logout`

These two tasks follow Tasks 1–8, which are already built. The owner removed the Settings section, and switching account is now `/logout` then `/login`.

### Task 9: `claude.signOut` in the service and the mock

**Files:**
- Modify:
  - `packages/protocol/src/methods.ts` (protocol 14 isn't released, so no version bump);
  - `packages/protocol/test/claude-login.test.ts`;
  - `apps/desktop/src-tauri/core/src/methods.rs` and the core fixtures (`REFUSED`);
  - `packages/service/src/claude-login/login.ts`;
  - `packages/service/src/server/handlers/claude-login.ts`;
  - `packages/service/src/main.ts`;
  - `packages/service/src/testing/mock-main.ts`.
- Test:
  - `packages/service/test/claude-login/login.test.ts`;
  - `packages/service/test/server/claude-login-handlers.test.ts`;
  - `packages/service/test/testing/mock-main.test.ts`.

**Interfaces:**
- Produces:
  - Method `claude.signOut {} → {}` (not `localOnly`).
  - `ClaudeLogin.signOut(): Promise<void>`. In order, it:
    1. refuses `LOGIN_UNSUPPORTED` on an API-key or provider machine (the same `refusal` predicate as a sign-in);
    2. cancels an open sign-in;
    3. runs Claude Code's `claude auth logout` on this machine through the same CLI runner `packages/service/src/mcp/config.ts` uses (the resolved `claude` path, the stripped env, a 30 s timeout, never in a shell);
    4. on success, sets the account to `null`, `expired: false`, publishes `claude.account`, and calls `restartAfterSignIn()` so live chats drop the old login;
    5. on failure, answers `LOGIN_FAILED` with Claude Code's stderr, trimmed and scrubbed.
  - The mock's `claude.signOut` sets its account to null and publishes, and `mock.claudeLoginReset` restores it.

- [ ] **Step 1: Write the failing tests:**
  - `signOut runs claude auth logout and clears the account`;
  - `signOut cancels an open sign-in`;
  - `signOut restarts the live chats`;
  - `an API-key machine refuses signOut`;
  - `a failing logout answers LOGIN_FAILED with Claude Code's words`;
  - the handler test for `claude.signOut`;
  - the mock test `the mock signs out and signs back in with MOCK-CODE`;
  - the protocol test `claude.signOut is listed`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.** Add `claude.signOut` to the core's `REFUSED` and regenerate its fixtures.
- [ ] **Step 4: Run** the protocol, service and core tests, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): /logout signs Claude Code out on a machine`.

### Task 10: Settings section out, `/logout` in the chat

**Files:**
- Delete: `apps/desktop/src/lib/components/ClaudeAccountsSettings.svelte` and its tests.
- Modify:
  - `SettingsDialog.svelte`;
  - `apps/desktop/src/lib/components/composer/commands.ts` (`logout` in `ALWAYS_LOCAL`, Claude-only, a `logout` control);
  - `ChatView.svelte`;
  - `apps/desktop/src/lib/state/claude-accounts.svelte.ts` (keep only what the dialog and sign-out use);
  - `apps/desktop/e2e/claude-login.spec.ts`;
  - `apps/desktop/e2e/phone.spec.ts`;
  - `README.md`;
  - `docs/architecture.md`.
- Create: `apps/desktop/src/lib/components/ClaudeSignOutDialog.svelte` (or a confirm built from the existing confirmation dialog component).

**Copy, fixed:**
- Confirmation:
  - Title: `Sign out of Claude on ‹machine›?`
  - Body: `Chats on ‹machine› can't answer until you sign in again with /login.`
  - Buttons: `Cancel`, `Sign out`.
- After success, a notice in the chat: `Signed out of Claude on ‹machine›. Type /login to sign in again.`
- An error shows Claude Code's words.
- An API-key machine: `‹machine› uses an API key, so there's nothing to sign out of.`

- [ ] **Step 1: Write the failing tests:**
  - `/logout is intercepted for a Claude chat and not for a Codex chat`;
  - `/logout asks first and signs out the chat's machine`;
  - `Cancel signs nothing out`;
  - the e2e `"/logout then /login switches the account on a paired machine"`, which replaces the Settings e2e;
  - the phone e2e `signs in a paired machine from the phone`, reworked to go through `/login` in a chat instead of Settings.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Remove the Settings section and any copy or test that only it used.
  - The README feature line becomes: sign in with `/login`, sign out with `/logout` (switching account is both). Drop the "Terminal-only commands like `/config` or `/logout`" limitation's `/logout`, so it reads `/config`.
  - `architecture.md` describes `/login`, `/logout` and `claude.signOut`.
- [ ] **Step 4: Run** the desktop suite, typecheck, lint, then the full e2e locally on shifted ports. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): /logout, and sign-in only from the chat`.

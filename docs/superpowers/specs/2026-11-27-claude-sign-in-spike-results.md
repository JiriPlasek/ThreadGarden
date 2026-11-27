# Sign in to Claude from Threadgarden: spike results

Date: 2026-11-27. This covers the "Left to the builder" spike questions of [the Claude sign-in design](2026-11-27-claude-sign-in-design.md).

## The test

**Tool:** `packages/service/test/real/claude-login.real.test.ts` (opt-in; run it with `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real claude-login`, without a `--` before the filter, which would run every real test). It is kept as the "recheck on every SDK update" check for the three undeclared `Query` methods `claudeAuthenticate(loginWithClaudeAi)`, `claudeOAuthCallback(authorizationCode, state)` and `claudeOAuthWaitForCompletion()` (control requests `claude_authenticate`, `claude_oauth_callback`, `claude_oauth_wait_for_completion`). Run with SDK 0.3.314 on This PC (Windows). The `claude` it found is the installed **2.1.330** (not 2.1.318).

**Setup:** every process runs with `CLAUDE_CONFIG_DIR` set to a fresh temp folder and with no inherited `CLAUDE*` / `ANTHROPIC*` variable, in a fresh temp working folder. `RealAdapter.start` runs the session, and the `Query`'s methods are called directly (the adapter keeps the `Query` private, so the test reaches it with a cast). Prompts are sent only in L3 (no login, and a fake dead login) and L4 (the owner's own sign-in, inside the temp folder). Codes, states and full links are never printed: links as host/path plus parameter names, responses as their keys.

**Isolation, checked first:** a process in a fresh `CLAUDE_CONFIG_DIR` reports `accountInfo()` = `{ tokenSource: 'none', apiProvider: 'firstParty' }` (no email, organization or plan), and Claude Code writes its `.claude.json`, `backups/`, `plugins/`, `sessions/` (and, after a turn, `projects/<folder>/`) inside the temp folder. The guard aborts the whole file if an account shows. After the runs: no new folder and no transcript with the run's session ids under `~/.claude/projects`, no entry for the temp folders in `~/.claude.json`, `~/.claude/.credentials.json` unchanged (hash compared), and the temp folders deleted.

## Results per check

| Check | Result | Evidence |
|---|---|---|
| Guard | **`CLAUDE_CONFIG_DIR` is honoured.** The process starts not signed in. | See "Isolation" above; 2 runs. |
| L1 start | **Works, with no login.** `claudeAuthenticate(true)` resolves at once (~1 s, a few ms in a warm process) with two links, `manualUrl` and `automaticUrl`. | See `AUTH_START`. |
| L2 wrong code | **Rejected, and the flow ends.** `claudeOAuthCallback('wrong', <state>)` rejects (~200 ms) with: `That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.` After that, `claudeOAuthWaitForCompletion()` rejects at once with `No active claude_authenticate flow`. | L2b: a wrong state gives the same "wasn't accepted" text. A second `claudeAuthenticate(true)` in the same process gives a new state and replaces the first: the first state then gets `No active claude_authenticate flow`. L2d: a wait that was pending when the wrong code arrived rejects with the same "wasn't accepted" text. L2c: in a process with no flow, both `claudeOAuthCallback` and `claudeOAuthWaitForCompletion` reject with `No active claude_authenticate flow`. |
| L3 no login | **The turn fails at once; the controls still work in that process.** `hi` gives `result` `subtype: 'success'`, `is_error: true`, `result: 'Not logged in · Please run /login'`, and an `assistant` message with `error: 'authentication_failed'`. No `auth_status` message. Afterwards `claudeAuthenticate(true)` in the same process returns the same two-link shape. | Messages: `system/init`, `system/status`, `assistant`, `result/success`. |
| L3 dead login (extra) | **Same, with kumbal's exact error.** With a fake expired `.credentials.json` (bogus refresh token) in the temp folder, `hi` gives `is_error: true`, `result: 'Failed to authenticate: OAuth session expired and could not be refreshed'`, `assistant.error: 'authentication_failed'`, no `auth_status`. `claudeAuthenticate(true)` afterwards in the same process works. `accountInfo()` before and after looks like "no login" (`tokenSource: 'none'`), but this fake had no account record in `.claude.json`, which a real expired login has. | Messages as in L3. |
| L4 complete (owner) | **Pending: owner run.** | Run with `THREADGARDEN_REAL_LOGIN=1`, see "Running L4". |

## Findings that change the design

- **A failed code ends the sign-in.** After a wrong code (or a wrong state) there is no flow to retry: the dialog must say so ("That code wasn't accepted…" is Claude Code's own wording and already says "Sign in again") and offer a new sign-in, i.e. call `claudeAuthenticate(true)` again for a new link. The old link is then dead.
- **Two links come back, and only the manual one fits Threadgarden.** `automaticUrl` redirects to `http://localhost:<port>/callback` on the machine running Claude Code, so it only works when the browser runs on that same machine. `manualUrl` redirects to `https://platform.claude.com/oauth/code/callback`, which shows the code to paste: that one works from any device, so it is the link to show. (Whether the localhost listener could also complete a sign-in on This PC was not tested; not needed.)
- **No `auth_status` message showed up in any check** (control requests, a no-login turn, a dead-login turn). A login failure is recognised by `assistant.error === 'authentication_failed'` and the `result` with `is_error: true`; the `result` text is `Not logged in · Please run /login` (never signed in) or `Failed to authenticate: OAuth session expired and could not be refreshed` (dead). Note the result's `subtype` is `success` in both cases.
- **The controls work in any live process,** including one whose turn just failed on login, so the failed chat's own process can run the sign-in. A short-lived process also works (L1 used a fresh one; the first call takes ~1 s while it starts).

## Constants for the build

- `AUTH_START`: `claudeAuthenticate(true)` resolves `{ manualUrl, automaticUrl }`, nothing else (no `state` key).
  - `manualUrl`: `https://claude.com/cai/oauth/authorize?{code,client_id,response_type,redirect_uri,scope,code_challenge,code_challenge_method,state}` with `redirect_uri` = `https://platform.claude.com/oauth/code/callback`. This is the link to show.
  - `automaticUrl`: the same host, path and parameters, with `redirect_uri` = `http://localhost:<port>/callback` (a new port per start).
  - Both carry the same `state` (43 characters, base64url). The caller takes it from `new URL(manualUrl).searchParams.get('state')` if it needs one.
  - A second call in the same process replaces the flow (new state); the earlier state is then answered with `No active claude_authenticate flow`.
- `CODE_SHAPE`: **pending: owner run** (expected `code#state`, as in Claude Code's own `/login`; L4 reports which, and whether the pasted state equals the link's). `claudeOAuthCallback(authorizationCode, state)` takes them separately; L4 submits the part before `#` as the code and the part after it (or the link's state) as the state.
- `WAIT_RESULT`:
  - On failure: a pending `claudeOAuthWaitForCompletion()` rejects with the callback's own error text (`That code wasn't accepted. …`). Called when no flow is active (none started, or after a failed code), it rejects at once with `No active claude_authenticate flow`. Before any code it stays pending (checked for 3 s).
  - On success: **pending: owner run** (L4 starts the wait before submitting the code, reports what it resolves with, and what a second wait call returns afterwards).
- `CALLBACK_ERRORS` (extra): a wrong code or a wrong state → `That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.`; no flow → `No active claude_authenticate flow`. Both arrive as a rejected promise with that message.
- `WORKS_WHEN_EXPIRED`: **`true`** for both a process started with no login and one with a dead login, also after a turn in that process failed on it. Completing a sign-in in such a process is part of L4 (its process starts with no login).
- `LOGIN_FAILURE_SIGNALS` (extra): `assistant.error: 'authentication_failed'` plus `result.is_error: true` (`subtype: 'success'`), with `result` text `Not logged in · Please run /login` or `Failed to authenticate: OAuth session expired and could not be refreshed`. No `auth_status`.
- `ACCOUNT_AFTER`: **pending: owner run** (L4 reports `accountInfo()` in the same process: email domain, plan, `tokenSource`; and the `auth_status` count and outputs). Before a sign-in, `accountInfo()` is `{ tokenSource: 'none', apiProvider: 'firstParty' }`.
- `OTHERS_PICK_UP`: **pending: owner run** (L4: a second process in the same config folder, started before the code is submitted, reports `accountInfo()` and answers a one-word prompt afterwards or not; a third process started after the sign-in reports `accountInfo()`).

## Running L4

The controller runs it with the owner present (PowerShell, from the repo root):

```
$env:THREADGARDEN_REAL_LOGIN='1'; pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real claude-login; Remove-Item Env:THREADGARDEN_REAL_LOGIN
```

L1–L3 run first (about 15 s), then L4 prints that the link is in `%TEMP%\tg-login-spike\link.txt`. The owner opens that link, approves on claude.ai, and saves exactly what claude.ai shows into `%TEMP%\tg-login-spike\code.txt` (one line). The test polls for it for up to 10 minutes, submits it, and reports. It deletes `link.txt`, `code.txt` and the temp config folder (with the new login in it) at the end, also when it fails. Only L4: add `-t L4` after `claude-login` (the isolation guard still runs).

The new login lives only in the temp folder and is deleted with it; the owner's own login in `~/.claude` is not touched. The sign-in does create one more claude.ai OAuth grant for the owner's account, which is left unused.

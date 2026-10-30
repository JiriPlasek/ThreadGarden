# pahub architecture

This file grows with the implementation. The design is in
[`docs/superpowers/specs/2026-10-30-pahub-v1-design.md`](superpowers/specs/2026-10-30-pahub-v1-design.md).

## Authentication

By default pahub never handles credentials: each session's `claude` process
inherits the environment of the pahub service, so it authenticates exactly as
the user's installed Claude Code does (subscription login or an API key in
the environment). If the user sets an API key in pahub's settings,
`buildSessionEnv` (`packages/service/src/sdk/real-adapter.ts`) copies the
service environment and adds `ANTHROPIC_API_KEY` for every session pahub
starts. The SDK's `env` option replaces the child environment, so the copy
keeps `PATH`, `HOME`, proxies and everything else.

### Verified behaviour (spec §5.5)

Checked on 2026-10-30 with Claude Code 2.1.314 and
`@anthropic-ai/claude-agent-sdk` 0.3.314 on Windows 11, signed in with a
subscription, using the opt-in real test
(`pnpm --filter @pahub/service test:real`, `test/real/smoke.real.test.ts`).

| Session environment | `accountInfo()` | `system/init` `apiKeySource` |
| --- | --- | --- |
| No `ANTHROPIC_API_KEY` | `apiProvider: "firstParty"`, `subscriptionType` set (the plan name), `email` set, no `apiKeySource`, no `tokenSource` | `"none"` |
| `ANTHROPIC_API_KEY` set (dummy value) | `apiProvider: "firstParty"`, `apiKeySource: "ANTHROPIC_API_KEY"`, `tokenSource: "claude.ai"`, no `subscriptionType`, no `email` | not observed (no turn was run) |

What this shows:

- Without a key, sessions run on the stored subscription login.
- With `ANTHROPIC_API_KEY` in the session environment, an SDK-mode session
  reports the key as its credential (`apiKeySource: "ANTHROPIC_API_KEY"`) and
  no longer reports the subscription, even though the stored login is still
  present (`tokenSource: "claude.ai"`). No approval prompt for the key
  appears in SDK mode.

What was **not** verified: that requests are actually billed to the key.
No real key was available, and with the dummy key no prompt was sent, to
avoid a failing API call. The check stopped at `accountInfo()`, which needs
only the session's initialize handshake. Verify this with a real key before
relying on API billing (send one short prompt with a real key and check the
key's usage in the Anthropic Console).

So the status bar's authentication label can come from `accountInfo()`:
`apiKeySource` present means an API key; otherwise `subscriptionType` and
`apiProvider` identify the login or a third-party provider.

### Other facts from the same run

- The `sessionId` pahub passes to the SDK for a new chat is the
  `session_id` in `system/init`, so the chat id is known before the CLI
  answers.
- A user text message sent through streaming input is **not** echoed back as
  a `user` SDK message, so the user item that `LiveSession` adds locally
  appears exactly once.
- A startup failure arrives as a `result` (`error_during_execution`) with
  `startup_failure_reason` and the CLI's message in `errors`. After it, the
  SDK's message iterator throws. pahub sets
  `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` so the CLI writes that result for
  every known cause. Checked with `proxy_invalid` (an unparsable
  `HTTPS_PROXY`), which fails before any API call.
- Running the service from inside a Claude Code terminal (inherited
  `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) did not change the session id
  or the authentication.

## Finding `claude`

`packages/service/src/sdk/claude-path.ts` hands the SDK the user's installed
`claude` as `pathToClaudeCodeExecutable`; there is no fallback to the SDK's
bundled binary. SDK 0.3.314 runs a path ending in `.js`/`.mjs`/`.ts`/`.tsx`/`.jsx`
with `node` (or `bun`) and spawns anything else directly with
`child_process.spawn` and no shell. On Windows that means a `.cmd` or `.bat`
launcher (what `npm install -g` creates) cannot be started. So discovery
prefers `claude.exe` everywhere. A `claude.cmd` is used only after resolving
it to the program it starts (npm's `cli.js` or a native `.exe`). If that
program cannot be determined, cannot be spawned or is missing, discovery
reports `unrunnable` with an explanation.

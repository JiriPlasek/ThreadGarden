# @pahub/service

Long-lived Node service that owns Claude Code sessions and serves the UI over a token-authenticated WebSocket bound to `127.0.0.1` (random port).

- Data dir: `%APPDATA%\pahub`, `~/Library/Application Support/pahub` or `${XDG_DATA_HOME:-~/.local/share}/pahub` (override with `PAHUB_DATA_DIR`).
- `service.json` (mode 0600) advertises pid, port, token and versions; `service.lock` enforces a single instance.
- The service exits after 30 minutes with no live sessions and no clients.
- Claude Code is driven only through `src/sdk/adapter.ts` (`AgentAdapter`, pinned `@anthropic-ai/claude-agent-sdk`); tests use `src/testing/fake-adapter.ts`. `src/chat/normalize.ts` maps every SDK message to a protocol `ChatItem`, with unrecognised messages and content blocks becoming `unknown` items that carry the raw JSON.
- `src/chat/live-session.ts` runs one live chat (send/queue, permission, question and plan flow, status, header) and emits sequenced `chat.items` / `chat.status` events, coalesced to at most one items event per 33 ms, into a per-session `EventLog` (last 5,000 events) for gap-free reconnect replay. `src/chat/session-host.ts` manages lifecycle: resume on demand, End session, Stop all work, idle reclaim (pinned and waiting chats are never reclaimed) and marking sessions that were live when the service stopped as interrupted.

- `src/sdk/real-adapter.ts` is the real `AgentAdapter`: one streaming-input `query()` per session, with the options pahub always uses (user/project/local settings, `claude_code` system prompt preset, partial messages, the installed `claude`). `src/sdk/claude-path.ts` finds that `claude` (settings path, `PATH`, `~/.local/bin`, `~/.claude/local`; no bundled-binary fallback). `src/sdk/startup-failure.ts` explains each reason Claude Code gives for refusing to start.

Scripts: `pnpm --filter @pahub/service dev` (tsx), `build` (bundles `dist/service.mjs`), `test`, and `test:real`. `test:real` runs `test/real/**` against your installed `claude` and its login. It sends one tiny prompt, so it is opt-in and never runs in `test` or CI. Authentication findings are in `docs/architecture.md`.

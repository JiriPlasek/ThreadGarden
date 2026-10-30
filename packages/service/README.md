# @pahub/service

Long-lived Node service that owns Claude Code sessions and serves the UI over a token-authenticated WebSocket bound to `127.0.0.1` (random port).

- Data dir: `%APPDATA%\pahub`, `~/Library/Application Support/pahub` or `${XDG_DATA_HOME:-~/.local/share}/pahub` (override with `PAHUB_DATA_DIR`).
- `service.json` (mode 0600) advertises pid, port, token and versions; `service.lock` enforces a single instance.
- The service exits after 30 minutes with no live sessions and no clients.
- Claude Code is driven only through `src/sdk/adapter.ts` (`AgentAdapter`, pinned `@anthropic-ai/claude-agent-sdk`); tests use `src/testing/fake-adapter.ts`. `src/chat/normalize.ts` maps every SDK message to a protocol `ChatItem`, with unrecognised messages and content blocks becoming `unknown` items that carry the raw JSON.

Scripts: `pnpm --filter @pahub/service dev` (tsx), `build` (bundles `dist/service.mjs`), `test`.

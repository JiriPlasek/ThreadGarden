# @pahub/service

Long-lived Node service that owns Claude Code sessions and serves the UI over a token-authenticated WebSocket bound to `127.0.0.1` (random port).

- Data dir: `%APPDATA%\pahub`, `~/Library/Application Support/pahub` or `${XDG_DATA_HOME:-~/.local/share}/pahub` (override with `PAHUB_DATA_DIR`).
- `service.json` (mode 0600) advertises pid, port, token and versions; `service.lock` enforces a single instance.
- The service exits after 30 minutes with no live sessions and no clients.

Scripts: `pnpm --filter @pahub/service dev` (tsx), `build` (bundles `dist/service.mjs`), `test`.

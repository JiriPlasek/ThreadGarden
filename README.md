# pahub

## Repository layout

- `packages/protocol` - shared types and zod schemas for the service/UI protocol
- `packages/service` - long-lived TypeScript service that owns Claude Code sessions, indexes history and serves the UI
- `apps/desktop` - Tauri 2 shell and SvelteKit UI; launches the service detached (see its README)

## Development

Requires Node 22 and pnpm; the desktop app also needs Rust (the version pinned in `rust-toolchain.toml`; rustup installs it) and the Tauri 2 system prerequisites (on Linux: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`).

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm format
```

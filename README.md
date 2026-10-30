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

`pnpm test` runs every package's tests, then the performance budgets (`pnpm test:perf`, one file at a time; `PAHUB_PERF_SLACK` multiplies the budgets, CI uses 3). `pnpm test:e2e` runs the Playwright specs (smoke and UI performance) in Chromium against the mock service; install the browser once with `pnpm --filter desktop exec playwright install chromium`.

## Release bundles

Release builds ship the service as one bundled file (`packages/service/dist/service.mjs`) run by a Node.js runtime packaged as the Tauri sidecar `pahub-node`. The runtime is the Node 22 LTS release pinned in `scripts/fetch-node-sidecar.mjs`, downloaded from nodejs.org and checked against pinned SHA-256 hashes and the release's `SHASUMS256.txt`:

```sh
node scripts/fetch-node-sidecar.mjs --target x86_64-pc-windows-msvc   # or aarch64-apple-darwin, x86_64-unknown-linux-gnu, …
pnpm --filter desktop tauri build --config src-tauri/tauri.bundle.conf.json
```

`--target` defaults to the host triple (`rustc -vV`). Installers land in `apps/desktop/src-tauri/target/release/bundle/` (MSI and NSIS on Windows, `.app` and DMG on macOS, deb, rpm and AppImage on Linux); they are not code-signed. CI builds them on all three platforms for every push and keeps them as workflow artifacts for 7 days.

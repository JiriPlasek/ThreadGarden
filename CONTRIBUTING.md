# Contributing to Threadgarden

Thanks for helping. This file covers the workflow, local setup and the rules the code base keeps. How the system fits together is in [docs/architecture.md](docs/architecture.md).

## Hard rule: Claude Code's data is read-only

Threadgarden must never write, rename, move or delete anything under the Claude config dir (`~/.claude`, or `CLAUDE_CONFIG_DIR` when set). A change that breaks this is not accepted, however useful the feature. In practice:

- Read history only through the Agent SDK (`listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`). Never open or parse transcript `.jsonl` files; their format is internal to Claude Code.
- File-system access under `~/.claude/projects` is limited to watching for changes (names, sizes, mtimes). Never read `~/.claude/jobs/`.
- Never call the SDK's `renameSession()` or `tagSession()`; titles and tags live in Threadgarden's own database.
- Read running sessions only from `claude agents --json`.
- Parse every external input leniently: unknown SDK message types, content blocks and `claude agents` fields must render as a generic "unrecognised" item with the raw JSON, never crash or be dropped.

`packages/service/test/e2e/read-only.test.ts` enforces this against a fixture config dir in every test run, and the opt-in real suite checks it against your real one.

Two related rules: Threadgarden never offers `bypassPermissions`, and it is never presented as Claude Code (it may say it works with Claude Code) or styled to look like it.

## Rules for remote machines

A headless service answers paired devices over the network ([Machines](docs/architecture.md#machines)), so the service keeps three rules:

- **Methods a paired device must not call are registered local only:** `router.register('pairing.create', handler, { localOnly: true })`. A remote caller gets `FORBIDDEN` before its params are read. Setup, pairing, device and machine management, secrets and shutdown are local only; when in doubt, make a new method local only. Every `router.dispatch` passes an origin (`{ clientId, origin: 'local' | 'remote' }`); there is deliberately no default, so a call site cannot grant local-only methods by forgetting it. A handler that must behave differently for a remote caller (like `devices.revoke`, which lets a device revoke only itself) checks `ctx.origin` and `ctx.deviceId`.
- **The relay never parses frames.** `server/relay.ts` pipes the UI's socket to the machine verbatim, both ways: it never parses, logs, rewrites or filters a frame, so it needs no change when the protocol grows and leaks no chat content into logs. Behaviour belongs in the services at either end.
- **The network side stays narrow.** The remote listener binds private addresses only (`privateListenAddresses`), never a wildcard or a public address; device tokens travel only in the WebSocket subprotocol, never in a URL or a log; nothing sends a pairing code before the machine has proved it knows it. Only tests and the mock service may listen on `127.0.0.1`, through test-only options (`remote.addresses` in `startService`, `src/testing/mock-main.ts --remote` for the Playwright specs); never through `bin.ts` or a `main.ts` default.

## Workflow

- One branch per change, opened as a pull request against `main`.
- [Conventional commits](https://www.conventionalcommits.org/): `feat(ui): …`, `fix(service): …`, `docs: …`, `test: …`, `build: …`, `ci: …`. Keep commits focused, and explain the reason in the body when it is not obvious.
- CI (`.github/workflows/ci.yml`) must pass on Windows, macOS and Linux: lint, type-check, unit and component tests, performance budgets, Rust fmt/clippy/tests, the release bundle build and the Playwright specs. A failure on any OS blocks the merge.
- Most contributors can test only one OS by hand. Write OS-specific code with all three branches, and say in the pull request what you tried by hand.
- Do not commit personal paths, user names, tokens or machine details, including in test fixtures and logs pasted into docs.

## Local setup

You need Node.js 22, pnpm 11, and for the desktop app Rust (rustup installs the toolchain pinned in `rust-toolchain.toml`) plus the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). To use the app for real you also need Claude Code installed and signed in.

```sh
pnpm install
pnpm --filter desktop tauri dev                 # the app, against your real history
pnpm --filter @threadgarden/service mock        # or: the service over a synthetic history
```

The mock service serves a synthetic history (1,000 chats) with a scripted fake Claude Code; messages containing "perm", "ask", "plan" or "limit" trigger those flows. To run the UI in a browser against it, set `VITE_THREADGARDEN_MOCK_URL` and `VITE_THREADGARDEN_MOCK_TOKEN`.

To build the release installers:

```sh
pnpm install
node scripts/fetch-node-sidecar.mjs   # the Node.js runtime bundled into the app, hash-checked
pnpm --filter desktop tauri build --config src-tauri/tauri.bundle.conf.json
```

They land in `apps/desktop/src-tauri/target/release/bundle/`. Users need no Node.js: the app ships its own runtime. Releasing is in [docs/releasing.md](docs/releasing.md).

The code is laid out as `packages/protocol` (shared schemas), `packages/service` (the Node.js service), `apps/desktop` (Tauri shell and SvelteKit UI), `packaging/headless` (the remote-machine package) and `scripts/` (release tooling).

## Tests

| Command                                         | What it runs                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                     | Every package's unit and component tests (Vitest), then `pnpm test:perf`                                                                                                                                |
| `pnpm test:perf`                                | The service performance budgets, one file at a time; `THREADGARDEN_PERF_SLACK` multiplies the budgets (CI uses 3)                                                                                       |
| `pnpm test:e2e`                                 | Playwright smoke and UI budget specs in Chromium against the mock service and a second, headless one that `machines.spec.ts` pairs with (`pnpm --filter desktop exec playwright install chromium` once) |
| `pnpm --filter <package> test`                  | One package's tests (`@threadgarden/protocol`, `@threadgarden/service`, `desktop`)                                                                                                                      |
| `cargo test` in `apps/desktop/src-tauri`        | The Rust shell (build the UI first: `pnpm --filter desktop build`)                                                                                                                                      |
| `pnpm --filter @threadgarden/service test:real` | Opt-in suite against your installed `claude` and your login; never in CI                                                                                                                                |

Service logic is tested against a fake SDK adapter (`packages/service/src/testing/fake-adapter.ts`); only `src/sdk/real-adapter.ts` calls the SDK at run time. A performance budget is a requirement, not a target: do not raise one to make a test pass.

## Code style

- TypeScript (ESM, strict). Declare functions as arrow functions (`const f = (…) => …`); classes are fine where state needs one.
- Svelte 5 runes only: `$props`, `$state`, `$derived` / `$derived.by`, `$effect`. No legacy `export let` or `$:`.
- Every `{#each}` block is keyed.
- shadcn-svelte components live in `apps/desktop/src/lib/components/ui/` and are added with `pnpm exec shadcn-svelte add …`.
- Formatting is Prettier (`pnpm format`; single quotes, trailing commas, width 100), LF line endings (`.editorconfig`, `.gitattributes`). Linting is ESLint (`pnpm lint`) and, for Rust, `cargo fmt` and `cargo clippy -D warnings` with the pinned toolchain.
- Comments explain why, not what. Every package keeps a README section describing what it contains.

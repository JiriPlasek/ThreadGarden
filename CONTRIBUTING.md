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

The root [README](README.md#development) shows how to run the UI in a browser against the mock service, and how to build release installers.

## Tests

| Command                                         | What it runs                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                     | Every package's unit and component tests (Vitest), then `pnpm test:perf`                                                                  |
| `pnpm test:perf`                                | The service performance budgets, one file at a time; `PAHUB_PERF_SLACK` multiplies the budgets (CI uses 3)                                |
| `pnpm test:e2e`                                 | Playwright smoke and UI budget specs in Chromium against the mock service (`pnpm --filter desktop exec playwright install chromium` once) |
| `pnpm --filter <package> test`                  | One package's tests (`@threadgarden/protocol`, `@threadgarden/service`, `desktop`)                                                        |
| `cargo test` in `apps/desktop/src-tauri`        | The Rust shell (build the UI first: `pnpm --filter desktop build`)                                                                        |
| `pnpm --filter @threadgarden/service test:real` | Opt-in suite against your installed `claude` and your login; never in CI                                                                  |

Service logic is tested against a fake SDK adapter (`packages/service/src/testing/fake-adapter.ts`); only `src/sdk/real-adapter.ts` calls the SDK at run time. A performance budget is a requirement, not a target: do not raise one to make a test pass.

## Code style

- TypeScript (ESM, strict). Declare functions as arrow functions (`const f = (…) => …`); classes are fine where state needs one.
- Svelte 5 runes only: `$props`, `$state`, `$derived` / `$derived.by`, `$effect`. No legacy `export let` or `$:`.
- Every `{#each}` block is keyed.
- shadcn-svelte components live in `apps/desktop/src/lib/components/ui/` and are added with `pnpm exec shadcn-svelte add …`.
- Formatting is Prettier (`pnpm format`; single quotes, trailing commas, width 100), LF line endings (`.editorconfig`, `.gitattributes`). Linting is ESLint (`pnpm lint`) and, for Rust, `cargo fmt` and `cargo clippy -D warnings` with the pinned toolchain.
- Comments explain why, not what. Every package keeps a README section describing what it contains.

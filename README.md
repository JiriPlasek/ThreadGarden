<img src="docs/images/logo.png" alt="" width="96" align="right">

# Threadgarden

**A desktop home for your [Claude Code](https://code.claude.com/docs) work.** Threadgarden lists every Claude Code conversation on your machine, runs new and resumed chats in tabs through the official Agent SDK and your own installed `claude`, and gathers everything that waits for you in one place. Agents keep running when you close the window, and an old PC on your network can do the work while your main one is busy.

> **Status:** experimental (v1.3). Windows, macOS and Linux. Threadgarden works with Claude Code; it is not affiliated with or endorsed by Anthropic.

<!-- Screenshots will live in docs/images/. -->

## Features

**Your history**

- Every Claude Code conversation, grouped by project (worktrees under their repository), with titles, previews and full-text search. Reading history never changes it.
- Chats sorted into **Now**, last 24 hours, 7 days, 30 days and older; filed as **Active**, **On hold** (until a time you pick, with a note) or **Archived**.
- New chats get a short title from a small model after their first turn (optional).
- **Analytics**: activity over time, tokens per model, busiest projects, most-used tools and a weekday × hour heatmap.

**Live chats**

- Tabs with streaming markdown, highlighted code, diffs, todo lists, thinking blocks and subagent activity under the call that started it.
- **Needs you** and **Running** across all projects, a strip with every running agent, a tray badge and notifications. Permission prompts, questions and plan approvals are answered inline.
- **Activity panel** (Ctrl/Cmd+.): a chat's subagents and background processes, with model, progress and details; processes can be stopped from there.
- Composer with `@` file mentions, slash commands, pasted images, queued messages and drafts that survive restarts.
- **Usage meter** for your plan's limits, and **scheduled sends**: "Send when the limit resets", or at any time you pick.
- Resume, fork and end any chat. Sessions started elsewhere (a terminal, `claude --bg`) show up too, with hand-off commands.

**Remote machines**

- Run chats on another computer on your network, such as an always-on Ubuntu PC, from the same window. Pair it once with a code; it gets its own group in the sidebar, and Needs you, Running and notifications cover every machine.
- The connection stays on your network, uses TLS pinned to the machine's certificate, and can be revoked from either side. Setup: [docs/remote-machines.md](docs/remote-machines.md).

**Comfort**

- Ctrl/Cmd+K quick switcher over chats, projects, messages and commands; every action has a [keyboard shortcut](#keyboard-shortcuts).
- Themes: light, dark or system, seven accents, a warm paper tint, Dim or true-black Midnight, your own fonts (WCAG AA contrast throughout).
- Project icons from each project's own favicon or logo; adjustable interface size.

## Install

There are no published releases yet.

**From CI.** Every push builds unsigned installers. Open a successful run of the [CI workflow](https://github.com/JiriPlasek/ThreadGarden/actions/workflows/ci.yml) and download the `threadgarden-<target>` artifact for your platform (kept 7 days): MSI or NSIS `setup.exe` on Windows, DMG on macOS, deb, rpm or AppImage on Linux. Builds are not code-signed, so SmartScreen and Gatekeeper warn on first launch.

**From source.** Node.js 22, pnpm 11, Rust (rustup picks the version in `rust-toolchain.toml`) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
pnpm install
node scripts/fetch-node-sidecar.mjs   # the Node.js runtime bundled into the app, hash-checked
pnpm --filter desktop tauri build --config src-tauri/tauri.bundle.conf.json
```

Installers land in `apps/desktop/src-tauri/target/release/bundle/`. Users need no Node.js: the app ships its own runtime.

**A remote machine** (optional) runs only the headless service: `./install.sh` from the `threadgarden-headless` package, then `threadgarden pair`. Step by step in [docs/remote-machines.md](docs/remote-machines.md).

<details>
<summary><b>Upgrading from pahub</b></summary>

Threadgarden was called pahub before v1.3. Install Threadgarden and start it; nothing is lost:

- **Your data moves.** On first start the service copies `pahub.db` from pahub's data dir to `threadgarden.db` in Threadgarden's, in one step, and uses only that afterwards. The old folder stays as it was, plus a `MOVED-TO-THREADGARDEN.txt`; delete it once Threadgarden runs fine.
- **A pahub service still running** shows as a service of another version: restart it from that screen and the new one takes over.
- **Your API key** moves from the `pahub` credential entry to `threadgarden` the first time it is read.
- **Not moved:** the notification permission and the start-on-login entry. Uninstall the old pahub app, and toggle Start on login again if you used it.
- `PAHUB_DATA_DIR` and `PAHUB_API_KEY_ONLY` still work for one release; use the `THREADGARDEN_` names.

</details>

## Requirements

- **Claude Code**, installed and signed in as you would use it in a terminal. Threadgarden runs your own `claude` and ships no copy of it. Alternatively, set an Anthropic API key in Settings.
- **Windows** 10/11 x64 (WebView2), **macOS** on Apple silicon, or **Linux** x64 with WebKitGTK 4.1.
- **Remote machine** (optional): Linux x64 with systemd and its own signed-in Claude Code.

## Data and privacy

- **Claude Code's data is read-only to Threadgarden.** It never writes, renames, moves or deletes anything under `~/.claude`. History is read only through the Agent SDK; running sessions through `claude agents --json`. The only writes there are Claude Code's own (the transcripts of chats you run, and the new file of a fork).
- **Threadgarden's own data** lives in `%APPDATA%\threadgarden`, `~/Library/Application Support/threadgarden` or `~/.local/share/threadgarden` (override with `THREADGARDEN_DATA_DIR`): a SQLite index of your conversations' text, your titles, buckets, drafts, settings and scheduled messages, plus logs without message content. Deleting the folder resets Threadgarden and touches nothing of Claude Code's. Treat it like `~/.claude` itself.
- **Secrets** (an API key, remote-machine pairing tokens) stay in the OS credential store and in memory; never in the database, files or logs.
- **Network:** the desktop service listens on `127.0.0.1` only, behind a random token. A headless remote machine also listens on its private network addresses (port 47380, TLS) for paired devices. Threadgarden contacts nothing else; the `claude` processes it starts talk to Anthropic exactly as in a terminal. Remote images in chats are not loaded.

## Authentication and terms

Threadgarden has no login of its own. Sessions use whatever authentication your Claude Code already uses (subscription, API key or a third-party provider), or the API key set in Settings; the chat header shows which. An API-key-only build is available: build with `THREADGARDEN_API_KEY_ONLY=1`.

You are responsible for complying with Anthropic's terms for the authentication you use. The Agent SDK documentation states that, unless previously approved, Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products and points to API keys instead; use of the SDK is governed by Anthropic's Commercial Terms. Read the current terms yourself; this is not legal advice. Details: [docs/architecture.md](docs/architecture.md#authentication).

## Known limitations

- No agent teams or embedded terminal (the Agent SDK has no interactive terminal session); tabs only, no split view yet.
- `bypassPermissions` is not offered; terminal-only slash commands (`/config`, `/login`, `/doctor`…) are listed as unavailable.
- Sessions running in another process are shown, not driven: Threadgarden offers hand-off commands and continues them once they stop.
- After Claude Code compacts a conversation, history shows it from the compaction onward (the SDK returns only the compacted part).
- Clicking a notification only focuses the window. Builds are unsigned, with no auto-update. macOS and Linux builds are tested in CI, not yet by hand.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # tests include the performance budgets
pnpm --filter desktop tauri dev            # run the app
pnpm test:e2e                              # Playwright against the mock service
```

- **Mock service:** `pnpm --filter @threadgarden/service mock` serves a synthetic history (1,000 chats) with a scripted fake Claude Code. Messages containing "perm", "ask", "plan" or "limit" trigger those flows. Point the UI at it in a browser with `VITE_THREADGARDEN_MOCK_URL` and `VITE_THREADGARDEN_MOCK_TOKEN`.
- **Rust:** in `apps/desktop/src-tauri`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (build the UI first).
- **Real Claude Code suite:** `pnpm --filter @threadgarden/service test:real`, opt-in, uses your login for a few tiny turns.

Layout: `packages/protocol` (shared schemas), `packages/service` (the Node.js service), `apps/desktop` (Tauri shell and SvelteKit UI), `packaging/headless` (the remote-machine package), `scripts/` (release tooling). How it fits together: [docs/architecture.md](docs/architecture.md). Workflow and rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Keyboard shortcuts

Press **Ctrl+/** (**⌘/** on macOS) or **?** to see them in the app. "Ctrl" means ⌘ on macOS, except in Ctrl+Tab.

<details>
<summary><b>All shortcuts</b></summary>

**Global**

| Keys        | Action                                                           |
| ----------- | ---------------------------------------------------------------- |
| Ctrl+K      | Open the quick switcher (chats, projects, messages and commands) |
| Ctrl+/ or ? | Show keyboard shortcuts                                          |
| Ctrl+N      | Start a new chat (in the selected project)                       |
| Esc         | Close a dialog or menu                                           |

**Tabs**

| Keys           | Action                                |
| -------------- | ------------------------------------- |
| Ctrl+W         | Close the active tab                  |
| Middle-click   | Close the tab under the pointer       |
| Ctrl+Tab       | Next tab                              |
| Ctrl+Shift+Tab | Previous tab                          |
| ← or →         | Previous or next tab (focus on a tab) |
| Home or End    | First or last tab (focus on a tab)    |
| Delete         | Close the focused tab                 |

**Chat list**

| Keys                 | Action                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| ↑ or ↓               | Move through the chats                                                    |
| Page Up or Page Down | Move a page of chats at a time                                            |
| Home or End          | First or last chat                                                        |
| Enter or Space       | Open the selected chat                                                    |
| ↓                    | From the search field, go to the list                                     |
| Esc                  | Clear the search                                                          |
| E                    | Archive the selected chats (or the one under the cursor)                  |
| H                    | Put on hold: choose until when and add a note                             |
| A                    | Make active (back from On hold or Archived)                               |
| Ctrl+Click           | Add a chat to the selection, or remove it                                 |
| Shift+Click          | Select a range of chats                                                   |
| Shift+Space          | Add the chat under the cursor to the selection, or remove it              |
| Ctrl+A               | Select every chat of the cursor's section (else of the first one in view) |
| Esc                  | Clear the selection                                                       |

**Composer**

| Keys                                                           | Action                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| Enter (Ctrl+Enter when "Enter sends the message" is off)       | Send the message (queued while Claude works)                 |
| Shift+Enter (also Enter when "Enter sends the message" is off) | New line                                                     |
| Esc                                                            | Stop Claude while it is working                              |
| @                                                              | Mention a file or folder                                     |
| /                                                              | Slash commands (at the start of the message)                 |
| Ctrl+V                                                         | Paste images, or a file path as a mention                    |
| Esc                                                            | Close the "Deny with feedback" field of a permission request |

**Pickers** (the `@` and `/` suggestions, and the quick switcher)

| Keys         | Action                                           |
| ------------ | ------------------------------------------------ |
| ↑ or ↓       | Move through the suggestions                     |
| Enter or Tab | Insert the selected file or command              |
| Esc          | Close the suggestions                            |
| ↑ or ↓       | Quick switcher: move through the results         |
| Enter        | Quick switcher: open the chat or run the command |

**Interface**

| Keys             | Action                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Ctrl+.           | Show or hide the Activity panel (agents and background processes)           |
| Ctrl+= or Ctrl++ | Larger interface                                                            |
| Ctrl+-           | Smaller interface                                                           |
| Ctrl+0           | Default interface size                                                      |
| ← or →           | Narrow or widen a column (focus on its divider; with Shift in bigger steps) |
| Home or End      | Narrowest or widest column (focus on its divider)                           |
| Double-click     | Reset a column's width (on its divider)                                     |

</details>

## License

Not yet chosen: all rights reserved until a license is added.

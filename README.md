<img src="docs/images/logo.png" alt="" width="96" align="right">

# Threadgarden

Threadgarden is a desktop app for running, watching and returning to your [Claude Code](https://code.claude.com/docs) work on one machine. It lists every Claude Code conversation you have had, grouped by project and searchable in full text, and runs new and resumed chats in tabs through the official Claude Agent SDK and your own installed `claude`. Chats that wait for you (a permission prompt, a question, a plan to approve) are collected in one place and announced with a notification, and sessions you started elsewhere (a terminal, an editor, `claude --bg`) show up next to Threadgarden's own. Agents keep running when you close the window.

Threadgarden works with Claude Code; it is not affiliated with or endorsed by Anthropic.

**Status:** v1, experimental. Expect rough edges; the data it keeps is its own and can be deleted at any time (see [Data and privacy](#data-and-privacy)).

<!-- Screenshots will live in docs/images/. -->

## Features

- **History of every Claude Code conversation** on the machine, grouped by project (git worktrees under their repository), with titles, previews and full-text search. Reading history never changes it.
- **Live chats in tabs**: streaming markdown with highlighted code, tool calls as compact expandable rows, edits as diffs, subagent activity under the call that started it, todo checklists, thinking blocks, and the model, context use, cost and authentication in the chat header.
- **Activity panel** beside the chat, one global toggle (Ctrl/Cmd+.): the subagents of a chat Threadgarden runs, with their model and progress, nested under the agent that launched them, and its background processes (a dev server, a watcher) with their status and running time, running ones on top. Each row expands to its details (the agent's prompt, model, timings, tokens, tool uses, summary, error); a process can be stopped from there. Tabs, chat-list rows and the agents strip show "N running" while any of them run, and the chat is listed under Running even when its turn is over.
- **Needs you** and **Running** across all projects, a bottom strip with every running agent, a tray badge and desktop notifications. Permission prompts, questions and plan approvals are answered inline.
- **Your turn**: a chat that finished while you were not looking gets a blue dot, joins Needs you below the chats waiting on an answer, and can post a notification (Settings, "Notify when a chat finishes"). Sending a message or answering a request scrolls the chat to the newest output. Projects whose folder is gone move into a collapsed "Missing folders" group, which explains itself on hover and can hide them all at once (reversible from Hidden projects).
- **Project icons**: each project shows the favicon or logo it already has (linked from its `index.html` or `app.html`, a `favicon.*`, `icon.*` or `logo.*` in the usual places, also inside `apps/*` and `packages/*`) in the project list, the chat header and the quick switcher; a project without one gets a coloured letter tile. Icons are read from the project folder only (images up to 512 KB that never point outside it), nothing is fetched from the network.
- **Recency sections** in every chat list: Now (needs you, your turn, running) first, then Last 24 hours, Last 7 days, Last 30 days and Older, each under a sticky header with a count.
- **Active, On hold and Archived**: every chat is in one of them (Threadgarden's own data, never written into Claude Code's). Put a chat on hold until tomorrow, next week or a time you pick, with a note ("waiting for review from Petr"); when the time comes it returns to Active, shows up under Needs you as "Back from hold" and posts a notification. Sending a message to a chat on hold ends the hold. Archived chats leave the lists, the agents strip and the main quick-switcher results, and come back by themselves when you send them a message or they run again (runs outside Threadgarden are noticed while "Show sessions running outside Threadgarden" is on in Settings). Move chats from a row's menu, the chat header, with E, H and A, or several at once (Ctrl/Cmd+click, Shift+click, Ctrl/Cmd+A); the Older section can archive everything older than 30 days in one go (pinned chats stay).
- **Chat names**: a new chat is named after its first message right away. After its first turn, a small model (Claude Code's `haiku`, one short request with no tools and no transcript) gives it a 3–6 word title. Renaming a chat always wins. To turn this off, clear "Name new chats automatically" in Settings. Titles are skipped when your Claude settings route requests elsewhere (an `env` block, `apiKeyHelper`, cloud credentials), so a title request never goes around the provider you chose.
- **Usage and scheduled sends**: a meter in the bottom strip shows how much of your plan's 5-hour limit is used and when it resets (amber when close, red when reached); click it, or "Usage" in Ctrl/Cmd+K, for every limit (weekly, per model, extra usage). Threadgarden reads this from the rate-limit updates Claude Code reports while chats run, and asks a running chat for a fresh reading when the Usage view opens; it never starts Claude Code just to check. When a limit refuses a chat, the chat says when it resets and the composer offers "Send when the limit resets". Any message can be scheduled from the send button's menu (when the limit resets, in 1 hour, tomorrow 09:00, or a time you pick); scheduled messages are listed above the composer (Send now, Edit, Cancel), chats with one show a clock, Threadgarden posts a notification when one goes out, and the service stays running until it has.
- **Composer** with `@` file mentions (fuzzy, respecting `.gitignore`), slash commands from the running Claude Code, pasted or dropped images, queued messages while Claude works, and drafts that survive restarts.
- **Resume, fork and end** any chat. Idle chats release their process after 15 minutes (configurable) and resume transparently on the next message.
- **External sessions** from `claude agents --json`, with copyable `claude --resume` / `claude attach` commands. Background sessions that Claude Code's own background service runs (`claude --bg`) can be stopped from Threadgarden (it runs `claude stop <id>` after a confirmation); sessions open in a terminal are stopped there. Threadgarden refuses to resume a session that is still running in another process.
- **Analytics** (from the places column or Ctrl/Cmd+K): chats, messages, output tokens and active days for the last 7, 30 or 90 days or all time, in all projects or one; messages and chats started over time, output tokens per model, the busiest projects (click one to see only it), the tools and subagent types used most, a weekday × hour heatmap of when you work and the most frequent words of your chat titles. Each chart has a "Show data" table. The numbers are gathered while Threadgarden indexes your history, from the messages it already reads; history indexed by an earlier version catches up in the background.
- **Ctrl/Cmd+K quick switcher** over titles, projects and full text, plus commands such as "New chat in…" and "Stop all work"; every action has a [keyboard shortcut](#keyboard-shortcuts), listed in the app with Ctrl/Cmd+/.
- **Adjustable interface size** (Ctrl/Cmd with =, - and 0, or in Settings).
- **Themes**: light, dark or follow the system, with an accent colour (Graphite, the default, or Blue, Teal, Green, Violet, Rose, Amber), a Warm paper tint for light, Dim or Midnight (true black, for OLED screens) for dark, Inter or the system font, and your own code font. Settings, Appearance, shows a live preview; the accents and styles keep WCAG AA contrast for text and buttons.
- **Remote machines**: run chats on another computer on your home network, such as an always-on Ubuntu PC, from the same window. Install the headless service there, run `threadgarden pair`, and add the machine in Settings → Machines with the code it shows. Each machine gets its own group of projects in the places column with its state (On, Connecting…, Unreachable, or Needs attention with the reason); Needs you, Running, the agents strip, notifications and Ctrl/Cmd+K cover every machine, with a machine chip on each row. The connection stays on your network, uses TLS pinned to the machine's certificate, and can be revoked from either side. Setup: [docs/remote-machines.md](docs/remote-machines.md).
- Windows, macOS and Linux.

## Keyboard shortcuts

Press **Ctrl+/** (**⌘/** on macOS), or **?** outside a text field, to see this list in the app; the quick switcher's "Keyboard shortcuts" command and the settings dialog open it too. "Ctrl" below is **⌘** on macOS, except in Ctrl+Tab, which is Control on every platform. The list is kept in `apps/desktop/src/lib/shortcuts.ts`; a test checks this section names every entry.

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

The interface size (80 % to 150 % in 10 % steps) is also in Settings, and Threadgarden remembers it.

## Requirements

- **Claude Code** installed and signed in, as you would use it in a terminal. Threadgarden runs your installed `claude` (found on `PATH`, in the standard install locations, or at a path set in Threadgarden's settings); it does not ship its own copy. v1 was developed and tested against Claude Code 2.1.314. Alternatively, set an Anthropic API key in Threadgarden's settings (see [Authentication and terms](#authentication-and-terms)).
- **External sessions** need `claude agents --json`. Without it that one feature hides itself and resuming asks for confirmation instead of checking.
- **Operating system:**
  - Windows 10 or 11, x64 (uses the system WebView2; the installer adds it if missing).
  - macOS on Apple silicon (CI builds `aarch64-apple-darwin`; Intel Macs can build from source with `--target x86_64-apple-darwin`).
  - Linux x64 with WebKitGTK 4.1 (built on Ubuntu 22.04 as deb, rpm and AppImage).
- **A remote machine** (optional) runs the headless service: Linux x64 (arm64 builds from source) with systemd, installed for your user from a tarball with `./install.sh` (no root, except one `sudo loginctl enable-linger` so it starts at boot), plus its own Claude Code, signed in. Step by step: [docs/remote-machines.md](docs/remote-machines.md).

## Install

There are no published releases yet.

**From CI artifacts.** Every push builds unsigned installers on all three platforms; open a successful run of the CI workflow on GitHub and download the `threadgarden-<target triple>` artifact for your platform (kept for 7 days): MSI or NSIS `setup.exe` on Windows, DMG on macOS, deb, rpm or AppImage on Linux. The builds are not code-signed, so Windows SmartScreen and macOS Gatekeeper warn before the first launch. On macOS an unsigned app downloaded from the internet may be reported as damaged; remove the quarantine attribute after copying it to Applications (`xattr -dr com.apple.quarantine /Applications/Threadgarden.app`) only if you trust the build.

**From source.** You need Node.js 22, pnpm 11, Rust (rustup installs the version pinned in `rust-toolchain.toml`) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS; on Debian or Ubuntu that is `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`.

```sh
pnpm install
# Downloads the Node.js runtime that ships inside the app and checks it against
# pinned SHA-256 hashes. --target defaults to your host (rustc -vV); pass
# x86_64-pc-windows-msvc, aarch64-apple-darwin, x86_64-apple-darwin,
# x86_64-unknown-linux-gnu, … to build for another one.
node scripts/fetch-node-sidecar.mjs
pnpm --filter desktop tauri build --config src-tauri/tauri.bundle.conf.json
```

The installers land in `apps/desktop/src-tauri/target/release/bundle/`. Release builds ship the service as one bundled file (`packages/service/dist/service.mjs`) run by a Node.js 22 LTS runtime packaged as the Tauri sidecar `threadgarden-node`, so users need no Node.js installation. The sidecar binary is downloaded from nodejs.org at build time, verified against `SHASUMS256.txt` and the hashes pinned in `scripts/fetch-node-sidecar.mjs`, and never committed.

### Upgrading from pahub

Threadgarden was called pahub before v1.3, and v1.3 renames its internals too. Install Threadgarden and start it; nothing is lost:

- **Your data moves.** On its first start the new service copies `pahub.db` from pahub's data dir (`%APPDATA%\pahub`, `~/Library/Application Support/pahub` or `${XDG_DATA_HOME:-~/.local/share}/pahub`) to `threadgarden.db` in Threadgarden's (see [Data and privacy](#data-and-privacy)) and uses only that from then on. The copy is made in one step, so an interrupted one is never used. The old folder is left as it was, plus a `MOVED-TO-THREADGARDEN.txt`; once Threadgarden runs fine you can delete it. Its logs are not copied. With `PAHUB_DATA_DIR` (or `THREADGARDEN_DATA_DIR`) set, the copy happens inside that one folder.
- **A pahub service that is still running** is found and shown as a service of another version: restart it from that screen, and the new service takes over and moves the data. While the old service runs, the new one does not start (it never starts on an empty database).
- **Your API key** moves from the `pahub` entry of the OS credential store to a `threadgarden` one the first time Threadgarden reads it.
- **Not moved:** the OS notification permission and the start-on-login entry, which belong to the app's new identity. Uninstall the old pahub app (it is a separate app), and if Start on login was on, turn it off and on again in Threadgarden's settings. The appearance cache of the window is rebuilt from your settings on the first connect.
- `PAHUB_DATA_DIR` and the `PAHUB_API_KEY_ONLY` build flag still work in this release, with a deprecation note; use `THREADGARDEN_DATA_DIR` and `THREADGARDEN_API_KEY_ONLY`.

## Development

```sh
pnpm install
pnpm lint          # ESLint in every package, plus scripts/
pnpm typecheck     # tsc and svelte-check
pnpm test          # unit and component tests, then the performance budgets
pnpm format        # Prettier
```

- **Run the app:** `pnpm --filter desktop tauri dev` builds the service, starts the UI on the Vite dev server and opens the app. A debug build runs the service with the `node` on your `PATH`.
- **Mock service:** `pnpm --filter @threadgarden/service mock` starts the real service over a synthetic history (1,000 sessions, 50 projects) with a scripted fake Claude Code, in temp dirs, and prints its port and token. A message containing "perm", "ask" or "plan" raises a permission request, a question or a plan approval; "limit" makes the mock account hit its usage limit for two minutes. Nothing touches your real history.
- **UI in a browser against the mock:**
  ```sh
  THREADGARDEN_MOCK_PORT=7357 THREADGARDEN_MOCK_TOKEN=dev pnpm --filter @threadgarden/service mock
  VITE_THREADGARDEN_MOCK_URL=ws://127.0.0.1:7357 VITE_THREADGARDEN_MOCK_TOKEN=dev pnpm --filter desktop dev
  ```
  (On Windows PowerShell set the variables with `$env:NAME = 'value'` first.)
- **Performance budgets:** `pnpm test:perf` (part of `pnpm test`) runs the service budget tests one file at a time. `THREADGARDEN_PERF_SLACK` multiplies every budget (default 1; CI uses 3, since the budgets are set for a developer machine).
- **End-to-end and UI performance:** `pnpm test:e2e` runs the Playwright specs in Chromium against the mock service (a smoke flow and the UI budgets: tab switch, history chat open, Ctrl+K, composer keystroke). Install the browser once with `pnpm --filter desktop exec playwright install chromium`.
- **Rust:** in `apps/desktop/src-tauri`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` (build the UI first with `pnpm --filter desktop build`).
- **Real Claude Code suite:** `pnpm --filter @threadgarden/service test:real` runs the service against your installed `claude` and your login, in throwaway git repos with tiny prompts (a handful of short turns on your account). It is opt-in and never runs in CI. It also checks that nothing under your Claude config dir changed, apart from what your other running Claude Code sessions wrote meanwhile.

Repository layout:

- `packages/protocol` — shared types and zod schemas for the service/UI protocol.
- `packages/service` — the long-lived Node.js service: Claude Code sessions, history index, external sessions.
- `apps/desktop` — the Tauri 2 shell (Rust) and the SvelteKit UI.
- `scripts/` — release tooling (the Node.js sidecar download).

Each package's README has the details. How the pieces fit together is in [docs/architecture.md](docs/architecture.md); [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow and project rules.

## Data and privacy

**Claude Code's data is read-only to Threadgarden.** Threadgarden never writes, renames, moves or deletes anything under your Claude config dir (`~/.claude`, or `CLAUDE_CONFIG_DIR` when set). It reads:

- your sessions' list, metadata and messages only through the Agent SDK (`listSessions`, `getSessionInfo`, `getSessionMessages`); it never parses transcript files itself;
- file-system change events under `~/.claude/projects/` (file names only), to know when to ask the SDK again;
- running sessions from `claude agents --json --all`, the documented interface for that.

Outside the config dir, Threadgarden reads a project's own folder only to find its icon (the HTML entry files and a few image files, see [Features](#features)); it never writes there.

The only writes under the config dir are the ones Claude Code makes itself: the transcripts of the sessions you run in Threadgarden, and the new session file the SDK writes when you fork a chat (the original is left untouched). Renaming a chat in Threadgarden stores a Threadgarden-side title; it never changes Claude Code's session name. Uninstalling Threadgarden leaves Claude Code exactly as it was, and switching back to the terminal is always safe. Sessions Threadgarden starts do not appear in the terminal's `/resume` picker (an Agent SDK behaviour); `claude --resume <session-id>` resumes them, and Threadgarden copies that command for you.

**What Threadgarden stores**, all in its own data dir:

| OS      | Location                                        |
| ------- | ----------------------------------------------- |
| Windows | `%APPDATA%\threadgarden`                        |
| macOS   | `~/Library/Application Support/threadgarden`    |
| Linux   | `${XDG_DATA_HOME:-~/.local/share}/threadgarden` |

Set `THREADGARDEN_DATA_DIR` to use another directory. It holds `threadgarden.db` (SQLite: a full-text index of your conversations' user and assistant text, Threadgarden-side titles, pins, hidden projects, drafts, settings, tab and layout state, which chats were running, for crash recovery, the latest usage-limit readings, and your scheduled messages with their images until they are sent), `service.json` (how the app finds the running service: pid, port, access token; readable only by you), a lock file, and `logs/` (rotating; message content is not logged). Deleting the directory resets Threadgarden completely and touches nothing of Claude Code's. Because the index holds the text of your conversations, treat this directory like `~/.claude` itself.

**API key:** if you enter one, it is kept in the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service on Linux) and handed to the service in memory; it is never written to `threadgarden.db`, `service.json` or the logs. The credential entry is named `threadgarden` (`pahub` before v1.3, see [Upgrading from pahub](#upgrading-from-pahub)).

**Network:** the service listens on `127.0.0.1` only, on a random port, and accepts only connections that present the random token from `service.json`. A headless install on a remote machine also listens on that machine's private network addresses (port 47380, TLS), for the devices paired with it; the desktop app never does. Threadgarden itself contacts no servers other than the machines you paired: the `claude` processes it starts talk to Anthropic exactly as they do in a terminal. Remote images in chat content are not loaded (they show as links), and links open in your system browser.

## Authentication and terms

Threadgarden has no login of its own. By default every session it starts uses whatever authentication your installed Claude Code already uses (a Claude subscription login, an API key in the environment, or a configured third-party provider). If you set an Anthropic API key in Threadgarden's settings, Threadgarden passes it to the sessions it starts as `ANTHROPIC_API_KEY`, and they use the key instead; removing it returns to the inherited authentication. The chat header shows which authentication a session reports, so you can see whether it runs on a subscription or on API billing. What was verified about this is in [docs/architecture.md](docs/architecture.md#authentication).

**API-key-only build.** To ship Threadgarden without the option of inheriting Claude Code's own sign-in (spec §5.5), build it with `THREADGARDEN_API_KEY_ONLY=1` set, for example `THREADGARDEN_API_KEY_ONLY=1 pnpm --filter desktop tauri build` (the old name `PAHUB_API_KEY_ONLY` still works in this release, with a deprecation note). The flag is baked into both the UI and the bundled service at build time (it cannot be switched on or off by the environment of an installed app). In such a build, chats start or continue only once an Anthropic API key is set in Settings: the service refuses `chat.create` and resuming a chat without one (`API_KEY_REQUIRED`), the settings and new-chat dialogs say that a key is required, and history stays browsable without a key.

You are responsible for complying with Anthropic's terms for the authentication you use. For reference, the Agent SDK documentation states that, unless previously approved, Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK, and points to API key authentication instead; use of the SDK is governed by Anthropic's Commercial Terms. Read the current documentation and terms yourself; this section is not legal advice.

## Known limitations (v1)

- No agent teams and no embedded terminal pane: teams need an interactive terminal session, which the Agent SDK does not provide.
- Open chats are tabs only; side-by-side split view is planned.
- The `bypassPermissions` permission mode is not offered; use the terminal for sessions that need it.
- Terminal-only slash commands (for example `/config`, `/login`, `/doctor`, `/vim`) are listed as unavailable; `/model`, `/permissions` and `/effort` open the matching pickers in the chat header.
- Clicking a notification only focuses Threadgarden (the notification plugin reports no clicks); Threadgarden then opens the "Needs you" list, and the chat itself when it is the only one waiting.
- Sessions running in other processes are shown, not driven: Threadgarden offers hand-off commands, and continues them only once they have stopped.
- New files appear in `@` suggestions up to 30 seconds after they are created.
- After Claude Code compacts a conversation, reopening it from history shows it from the compaction onward: the Agent SDK returns only the compacted conversation.
- Background-task notifications and subagent hand-backs that Claude Code records as user turns show as one-line notices (the full text on demand), as the terminal shows them; other tagged entries Claude Code may add in later versions show as raw text until Threadgarden learns them.
- macOS and Linux builds are built and tested in CI but have not been tried by hand.
- Builds are unsigned, and there is no auto-update.

## License

Not yet chosen — all rights reserved until a license is added.

# `!` commands: a real terminal in the chat

Designed with the owner on 2026-11-22; the builder check's questions are answered in the text. Piece 2 of two; piece 1 is MCP servers in the chat
(`2026-11-22-mcp-servers-design.md`).

## Why

The owner runs chats on a headless Ubuntu PC (wobble) and keeps having to SSH in for things a chat can't do.
Claude Code's CLI has `!` (bash mode): you run a command yourself and its output lands in the conversation, so you
can say "fix that". Claude itself suggests `!`, but Threadgarden has no such mode. Commands on a headless box often
ask questions (`sudo`'s password, apt's `[Y/n]`, `gh auth login`, git credentials), so a plain run isn't enough:
the owner wants a real terminal.

## Goals

- Type `!` and a command in the message box (desktop and phone). It runs **in a real pseudo-terminal on the chat's
  machine, in the chat's folder**, shown as a live terminal block in the chat.
- You can type into the block while the command runs (a password, `y`, anything interactive), and stop it with
  Ctrl+C in the block or a **Stop** button.
- When the command ends, its output goes into the conversation **without starting a turn**; Claude reads it with
  the next message, exactly as with the CLI's `!`.
- It looks the same live, after a restart, in history and to a `claude --resume` in a terminal.

## Non-goals

- A persistent shell per chat. **Each `!` is its own fresh run** (decided by the owner): `cd`, `export` and sudo's
  remembered password don't carry over to the next `!`.
- A general terminal panel or a terminal per project (still in the vault's *To decide*).
- `!` in Codex chats. Claude chats only; in a Codex chat `!` is sent as ordinary text, as today.
- Running `!` on an away (off) machine. The composer says the machine is off, as for other actions that need it.
- Choosing the shell in Settings.
- `!` as the first message of a new chat (decided by the owner: starting a chat with `!` is odd). In New chat a
  leading `!` is plain prompt text; command mode exists only in a chat that already has a session.

## Anti-goals

- A password typed into the terminal must never reach the transcript, the logs, the event log or Claude. (A
  terminal doesn't echo a password prompt's input, so it isn't in the output; Threadgarden must not record the
  keystrokes it forwards either.)
- Never starts a turn on its own. The output waits for the user's next message.
- No surprise processes: a `!` command never outlives its block without the user knowing (ending the session or
  the chat stops it, as End session stops Claude's processes).

## Approaches

- **Real terminal (PTY) in the service (chosen by the owner).** The service on the chat's machine spawns the
  command in a pseudo-terminal (node-pty: ConPTY on Windows, a Unix PTY elsewhere), streams the bytes to the UI
  through the existing socket and relay, and the UI renders them with xterm.js. It works on every machine because
  the service runs there; the Rust shell isn't on a headless machine. The cost is a native module in the service,
  on all three OSes and in the headless builds.
- Plain run with pipes, plus a password field for `sudo -S`. No native dependency, but anything else that asks a
  question breaks (`[Y/n]`, `gh auth login`): rejected by the owner.
- A persistent shell per chat (`cd` and sudo's cache carry over). Hidden state, a hung command blocks the next one,
  more lifecycle (idle reclaim, restarts, Move to…): rejected by the owner.

## Decided

**What the user sees.**

```
 You  ! sudo apt upgrade
 ┌ ! sudo apt upgrade · wobble · ~/projects/etoro_analysis ─────── [Stop] ┐
 │ [sudo] password for wobbletron:                                    │
 │ Reading package lists... Done                                          │
 │ Do you want to continue? [Y/n] █                                       │
 └─────────────────────────────────────────────────────────────────────────┘
 (ended) ✓ exit 0 · 14 s · Claude sees the output with your next message
```

- **Starting it.** A message that starts with `!` in a Claude chat is a command, not a prompt. The composer shows it
  is in command mode (as the CLI tints its prompt). The rest of the line is the command. Images and file tags in a
  `!` message are not sent.
- **Where it runs.** On the chat's machine, in the chat's folder, in a fresh PTY each time.
- **The shell.** The one Claude Code's own Bash tool uses there: the user's bash on Linux and macOS; on Windows Git
  Bash when it's installed, else PowerShell. The command line is passed to that shell as one command string.
- **While it runs.** Keystrokes in the block go to the PTY. **Stop** sends an interrupt (Ctrl+C) and, if the
  process hasn't ended a few seconds later, kills it. The block follows the pane's width (the PTY is resized).
  *Builder's call, settled in review:* any of the user's connected windows or devices showing the chat can type into
  it, not only the one that started it. They are all the owner's paired devices, and a strict "only the starter"
  rule breaks the main case: `sudo apt upgrade` started on the phone, whose connection drops when the screen locks.
  The service keeps the command's recent output (a bounded scrollback) so a window that opens the chat or
  reconnects mid-run redraws the terminal. Closing a tab or window doesn't stop the command; it stays visible in the
  chat and in **Running**.
- **When it ends.** The service appends one user message to the session with `shouldQuery: false` (the SDK's
  documented use for bash mode): `<bash-input>` with the command and `<bash-stdout>` with the output, in the same
  format the CLI writes (normalize.ts already renders that as `! command` plus a system line). The output is the
  terminal's text with escape codes removed; if it is very long, only its end is kept, with a note that the start
  was cut, following the CLI's limit. The exit code and duration show under the block.
- **While Claude is working.** `!` can run during a turn. Its output is appended when it ends and reaches Claude with
  the next user message, as the SDK merges `shouldQuery: false` messages forward.
- **A chat with no live session** (paused, from history): `!` resumes the session like sending a message does
  (through the same resume-safety check), because the output has to be appended to it.
- **After a restart or in history** the chat shows what the transcript holds: the `! command` line and its output.
  The live terminal rendering is only for the run itself.
- **Lifecycle.** A running `!` command keeps the session from idle reclaim, like a running background task. *Builder's
  call, settled in review:* unlike background shells (which deliberately don't keep a machine awake), a running `!`
  counts as busy for the machine's idle shutdown, so wobble never powers off while `sudo apt upgrade` waits at
  `[Y/n]`; it shows in **Running** and counts there, so a forgotten one is easy to see and stop. End
  session, Stop all work, Move to… and shutting the service down end it (Move to… and End session warn that a
  command is running). A command still running when the service stops is not appended.
- **Protocol 13** (after piece 1's 12), with a `shell` capability. *Builder's call:* piece 1 merges first; if the
  two are built in parallel, whichever merges second takes the next number and adds its line to `version.ts`; a paired machine without it doesn't offer `!`.
  Methods to start a command, send input, resize and stop; events carrying output chunks and the end (exit code).
  Output chunks go through the relay as they come. The event log never stores input.
- **Packaging.** node-pty's native binary ships for every target the service runs on: the desktop app's service on
  Windows x64, macOS arm64 and Linux x64, the headless Linux install and the native Windows worker. It must match
  the Node version of the bundled `threadgarden-node` sidecar. The esbuild bundle keeps node-pty external and the
  binary sits next to `service.mjs`.

## Left to the builder

- **Spike first:** node-pty (or a maintained fork with prebuilt binaries, such as `@lydell/node-pty`) running under
  the sidecar's Node on Windows (ConPTY) and Linux, packaged with the esbuild bundle and the headless installers.
  If no fork gives prebuilt binaries for all targets, report back before building; don't add a compiler to the
  install steps.
- Check on the real CLI: the exact transcript entries the CLI writes for `!` (tags, `<bash-stderr>` when the PTY
  merges both streams, how the output limit and the cut are worded), and that a `shouldQuery: false` message really
  reaches Claude with the next turn.
- How Claude Code picks its shell on Windows, so `!` uses the same one.
- The protocol's message names and chunk sizes; coalescing output so a noisy command doesn't flood the relay or
  the phone.
- How the composer shows command mode, and the block's look (theme colors, font, height limit with scrolling).
- The phone's keyboard in the terminal block (special keys like Ctrl+C come from the Stop button).

# `!` commands: a real terminal in the chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Claude chat, a message starting with `!` runs as a command in a fresh pseudo-terminal on the chat's machine, in the chat's folder. It shows as a live terminal block you can type into and stop. When it ends, its output is added to the conversation without starting a turn, so Claude reads it with your next message. It works the same on This PC, a paired machine and the phone.

**Architecture:** A new `packages/service/src/shell/` module wraps a prebuilt node-pty fork (loaded at run time, kept outside the esbuild bundle in a `node_modules/` beside `service.mjs`). `PtyRun` spawns the shell line Claude Code's Bash tool would use, keeps a bounded scrollback, and sends coalesced, rate-capped output as `shell.output` events. When the command ends, it hands the cleaned and limited text back. `LiveSession` owns at most one run per chat: it appends that text as an SDK user message with `shouldQuery: false`, in the CLI's `<bash-input>`/`<bash-stdout>` format, counts the run as a running task and agent, and kills it when the session ends or crashes. New `shell.*` methods, `shell.run`/`shell.output` events and a `shell` capability (protocol 13) carry it through the relay. The UI adds command mode to the composer and an xterm.js `ShellBlock` to the message list.

**Tech Stack:** TypeScript, zod (protocol), Node 22 service on the `threadgarden-node` sidecar (v22.23.4), a node-pty fork with prebuilt N-API binaries (Task 1 picks it; `@lydell/node-pty` is the first candidate), `@xterm/xterm` + `@xterm/addon-fit`, Svelte 5 + Tailwind, Tauri 2 resources, Rust (core constants), vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-22-shell-commands-design.md`

## Global Constraints

- Claude chats that already have a session, only. In a Codex chat, in New chat and as a first message, a leading `!` is plain prompt text, as today.
- Each `!` is its own fresh PTY on the chat's machine, in the chat's folder. No persistent shell: `cd`, `export` and sudo's cache don't carry over.
- Never starts a turn. The output is appended with `shouldQuery: false` and reaches Claude with the next user message. Appending never changes the chat's status, never emits `chatFinished` and never joins `queued`.
- A password never reaches the transcript, the logs, the event log or Claude. `shell.input` data goes to the PTY and nowhere else: not into events, the database, `ui.error`, the service log, `onError`, an error message, the scrollback or the transcript text.
- No surprise processes. End session, Stop all work, Move to…, service shutdown and a crashed Claude process all end a running command. A command ended that way is not appended. Closing a tab or window does not stop it.
- A running `!` keeps its session from idle reclaim and counts as busy for the machine's idle shutdown (unlike background shells). It shows in **Running** and counts there.
- Protocol: `PROTOCOL_VERSION = 13`; `REMOTE_PROTOCOL_RANGE = { min: 12, max: 14 }`; capability `'shell'` (`SHELL_CAPABILITY`), added at runtime only when the PTY module loads. Piece 1 (MCP servers, protocol 12) merges first. **Renumber rule (spec):** if this branch merges before piece 1, it takes 12 and piece 1 takes 13; whichever merges second takes the next number and adds its own line to `version.ts`. A machine without `shell` doesn't offer `!`.
- Packaging: prebuilt binaries only, for Windows x64, macOS arm64 and Linux x64 (desktop service, headless Linux, native Windows worker). Never add a compiler or `node-gyp` to a build or install step. esbuild keeps the PTY package external, and its files sit in `node_modules/` beside `service.mjs`.
- The shell is the one Claude Code's own Bash tool uses there (Task 1 records the rule). The command string goes to that shell as one argument.
- The transcript text is the terminal's text with escape codes removed. Past the CLI's limit only the end is kept, with the CLI's note that the start was cut.
- Copy, fixed here. Footer: `✓ exit 0 · 14 s · Claude sees the output with your next message`, `✗ exit ‹n› · ‹duration› · Claude sees the output with your next message`, `Stopped · ‹duration› · Claude sees the output with your next message`, `Stopped when the session ended · not added to the chat`, `Running · ‹duration›`. Block title: `! ‹command› · ‹machine› · ‹folder, ~ for home›`. Buttons: `Stop`, then `Stopping…` (disabled). Composer notices: `Type a command after !`, `‹machine› is off, so the command can't run there.` (or `‹machine› isn't connected, so…`, following the chat's away note), `Update ‹machine› to run ! commands here.`, `! commands are for Claude chats` (service error text).
- Run pnpm with `--config.verify-deps-before-run=false`. The worktree has no `node_modules`: install with the no-links recipe (memory `agent-env-no-links.md`: hoisted, copy, then restore `pnpm-workspace.yaml`). A new dependency goes into `package.json` and `pnpm-lock.yaml` only. `@threadgarden/protocol` resolves through the aliases. Commits carry no Claude attribution.

## Review Focus

1. **A flood of output** (`yes`, `cat` of a 50 MB log). The relay and the phone get at most the rate cap, with a visible "skipped" marker. The scrollback stays bounded. The transcript still gets the end within the CLI's limit. Task 4 test `a flood is rate-capped and the transcript keeps the end`.
2. **Progress bars and full-screen programs** (apt's `\r` progress, colours, `htop`). The transcript gets the final text, not hundreds of redraws or escape garbage. Task 3 test `applies carriage returns and drops escape sequences`.
3. **Output that contains the tags themselves** (`cat packages/service/src/chat/normalize.ts`). The entry stays well-formed per the CLI's rule, and history shows the whole output. Task 3 test `output that contains bash tags` and Task 5 test `output containing </bash-stdout> is kept whole`.
4. **A window that opens the chat or reconnects mid-run** (the phone's screen unlocks during `sudo apt upgrade`). It redraws from the scrollback and carries on with no lost or duplicated output. Task 4 test `attach mid-run continues from the scrollback's offset` and Task 9 test `resync reloads a running command's output`.
5. **Claude's process crashes while a command runs.** The command is killed, nothing is appended, and the block says so. Task 5 test `a crashed session stops its command`.

---

### Task 1: Spike — the PTY package, its packaging, and the real CLI

**Files:**
- Create: `scripts/pty-smoke.mjs` (`node scripts/pty-smoke.mjs <dir holding node_modules>`: imports the PTY package from that dir, runs `echo tg-pty-$((40+2))` in the platform's shell line, exits 0 only when the output has `tg-pty-42` and the exit code is 0; prints `[pty-smoke] ok <platform>-<arch> node <version>`). Task 7's CI steps run it again.
- Create: `packages/service/test/real/shell.real.test.ts` (opt-in, `THREADGARDEN_REAL=1`; report lines prefixed `[threadgarden-real]`)
- Create: `docs/superpowers/specs/2026-11-22-shell-commands-spike-results.md`
- Modify: `packages/service/package.json`, `pnpm-lock.yaml` (the chosen package)

**Interfaces:**
- Produces: the results doc, styled like `2026-11-02-move-chat-spike-results.md`, with a "Constants for the build" section that later tasks read:
  - `PTY_PACKAGE`: name and exact version. `PTY_PLATFORM_PACKAGES`: the package (or folder) holding the binary for `win32-x64`, `darwin-arm64`, `linux-x64` (and `linux-arm64` if it exists). `PTY_FILES`: per target, the files that must ship (the `.node` files; `conpty.dll`/`OpenConsole.exe` on Windows; `spawn-helper` and its exec bit on macOS). `PTY_NAPI`: whether the binaries are N-API (independent of Node's ABI) or must match Node 22's `NODE_MODULE_VERSION` 127.
  - `ENTRY_SHAPE`: `'one'` (one user entry holding both tags) or `'two'` (the CLI writes `<bash-input>` and the output as separate entries). `ENTRY_FORMAT`: the exact text of each entry, including whether an empty `<bash-stderr></bash-stderr>` is always written, the entry flags (`isMeta`, …), and whether the CLI escapes tag-like text inside output (`TAGS_ESCAPED`).
  - `OUTPUT_LIMIT` (characters) and `CUT_NOTE` (exact wording, and where it goes).
  - `ECHOES`: whether a `shouldQuery: false` message comes back on the SDK stream (and under which uuid), plus every frame it causes (`command_lifecycle`, `user_message_uuids`). `MID_TURN`: what happens when one is appended during a turn (does the running turn see it, or only the next user message?).
  - `UNIX_SHELL` (the rule and args, e.g. `$SHELL` when it's bash or zsh, else `bash`; `-c`, `-lc` or `-lic`) and `WINDOWS_SHELL` (how Git Bash is found: `CLAUDE_CODE_GIT_BASH_PATH`, then from `git` on PATH; else PowerShell: `pwsh` or `powershell.exe`, and its args, expected `-NoLogo -NoProfile -EncodedCommand <base64 UTF-16LE>`).

- [ ] **Step 1: Find the package.** For `@lydell/node-pty`, current `node-pty` (look for its `prebuilds/`) and `@homebridge/node-pty-prebuilt-multiarch`, record with `npm view` and the published tarballs: the platforms with prebuilt binaries, N-API or not, last release date, licence.
- [ ] **Step 2: GATE.** If no maintained package has prebuilt binaries for **all three** of win32-x64, darwin-arm64 and linux-x64, **stop. Write what you found in the results doc, commit it, and report to the owner.** Don't build anything further, and don't add a compiler to any step (spec).
- [ ] **Step 3: Install it** into `@threadgarden/service` with the no-links recipe. Mark it external in a scratch esbuild run, copy `PTY_FILES` into `<scratch>/node_modules/`, and run `scripts/pty-smoke.mjs <scratch>` under the sidecar Node (`node scripts/fetch-node-sidecar.mjs --target x86_64-pc-windows-msvc --out <tmp>/node.exe`). Do this on Windows (ConPTY) here, and on Linux on wobble over SSH (memory `ubuntu-pc-ssh.md`; copy the scratch dir plus a fetched linux-x64 sidecar). macOS arm64 is checked in CI by Task 7. Also run a Ctrl+C test (`sleep 30`, write `\x03`, it must exit), a resize test (`tput cols` after `resize(57, 20)` prints `57`), and a kill test. On Windows, check that killing ends the whole tree (`ping -t` under bash).
- [ ] **Step 4: Write `shell.real.test.ts`** with these checks, using `RealAdapter`, the user's own login, and a temp git folder:
  - `C1 the CLI's own ! entries`: drive the interactive `claude` in a PTY (the package from Step 3), type `! echo tg-c1` and `! ls /nonexistent-tg` (stderr), quit, and record the transcript entries through `getSessionMessages`. Also record the raw JSONL lines (spike only; the product never opens transcripts). Gives `ENTRY_SHAPE`, `ENTRY_FORMAT`.
  - `C2 limit`: in the same way, `! seq 1 200000`. Record the kept length and the cut note (`OUTPUT_LIMIT`, `CUT_NOTE`), and a `! printf '</bash-stdout>x'` (`TAGS_ESCAPED`).
  - `C3 shouldQuery false between turns`: append a `bashEntry` (`ENTRY_SHAPE` from C1) whose output holds a random nonce. Assert no `result` arrives within 5 s and record every message the stream yields (`ECHOES`). Then send `What did my last ! command print? Answer with that word only.` and assert the reply contains the nonce.
  - `C4 shouldQuery false mid-turn`: start a turn running `sleep 8` via Bash. Append a nonce entry 2 s in. Record whether that turn's later text mentions it, and whether a following question gets it (`MID_TURN`).
  - `C5 the shell Claude Code uses`: ask Claude to run `echo "$0|$BASH_VERSION|$ZSH_VERSION|$SHELL"` and `echo $PATH` (compare with the service's PATH to see whether it's a login environment). On Windows, also with `CLAUDE_CODE_GIT_BASH_PATH` set to a copy of `bash.exe`. Read code.claude.com's Windows setup page for the PowerShell fallback. Gives `UNIX_SHELL` and `WINDOWS_SHELL`. Run C5 on wobble too.
- [ ] **Step 5: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test:real -- shell` here and on wobble, and keep the output.
- [ ] **Step 6: Owner check (manual):** on wobble, `claude --resume <C3's session id>` in a terminal. Does the appended entry show like a CLI-made `!`? Record the answer.
- [ ] **Step 7: Write the results doc.** Include the setup, a table with one row per check (result, evidence), the constants, and these findings for the owner (report them, don't settle them):
  - if `ENTRY_SHAPE` is `'two'` (the spec says "one user message … in the same format the CLI writes");
  - if the CLI keeps the start of long output rather than the end (the spec says "only its end is kept … following the CLI's limit");
  - if Claude Code uses zsh for a zsh user (the spec says "the user's bash on Linux and macOS" and "the one Claude Code's own Bash tool uses");
  - if Step 6 shows a mismatch.
  The build follows the CLI in each case unless the owner says otherwise.
- [ ] **Step 8: Commit** `docs: ! commands spike results` (the smoke script, the real test, the doc, the dependency).

### Task 2: Protocol 13

**Files:**
- Create: `packages/protocol/src/shell.ts`, `packages/protocol/test/shell.test.ts`
- Modify: `packages/protocol/src/{methods,events,version,machines,move,index}.ts`. The version and range pins in `packages/protocol/test/{away,move,projects,power,update,usage,schemas,mcp}.test.ts` and `packages/protocol/test/fixtures/protocol-range.json`. `apps/desktop/tests/state/machines.test.ts` (`accepts a remote on protocol 12 or 14 but not 11 or 15`). `apps/desktop/src-tauri/src/service.rs` (`PROTOCOL_VERSION: u32 = 13`). `apps/desktop/src-tauri/core/src/lib.rs` (`PROTOCOL_VERSION = 13`, `REMOTE_PROTOCOL_RANGE = (12, 14)`). `apps/desktop/src-tauri/core/src/methods.rs` (the five `shell.*` methods into `REFUSED`: the phone's own core has no chats). `packages/protocol/test/fixtures/core-answers/*` (regenerated).

**Interfaces:**
- Produces (`shell.ts`):
  - `SHELL_CAPABILITY = 'shell'` (not in `CAPABILITIES`; added at runtime).
  - `SHELL_ERRORS = { unsupported: 'SHELL_UNSUPPORTED', busy: 'SHELL_BUSY', notRunning: 'SHELL_NOT_RUNNING', failed: 'SHELL_FAILED' }`.
  - `SHELL_COMMAND_MAX = 16_384`, `SHELL_INPUT_MAX = 65_536`, `SHELL_SCROLLBACK_CHARS = 262_144`, `SHELL_DEFAULT_SIZE = { cols: 100, rows: 24 }`. `ShellSizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(500) })`.
  - `ShellRunSchema = z.object({ runId: z.string(), sessionId: z.string(), command: z.string(), cwd: z.string(), cols, rows, startedAt: z.number(), state: z.enum(['running', 'stopping', 'ended']), endedAt: z.number().optional(), exitCode: z.number().int().nullable().optional(), endReason: z.enum(['exit', 'stopped', 'session']).optional(), entryId: z.string().optional() })`. `entryId` is the item id of the appended `! command` line, set once it's appended. `endReason: 'session'` means not appended.
  - `ShellViewSchema = z.object({ run: ShellRunSchema, output: z.string(), offset: z.number().int().nonnegative() })`. `output` is the scrollback; `offset` is how many emitted characters came before it.
  - Methods (none `localOnly`): `shell.start {sessionId, command: z.string().trim().min(1).max(SHELL_COMMAND_MAX), cols, rows} → ShellRunSchema`; `shell.input {runId, data: z.string().max(SHELL_INPUT_MAX)} → {}`; `shell.resize {runId, cols, rows} → {}`; `shell.stop {runId} → {}`; `shell.get {sessionId} → { view: ShellViewSchema.nullable() }`.
  - Events: `'shell.run': ShellRunSchema`; `'shell.output': z.object({ runId, sessionId, offset: z.number().int().nonnegative(), data: z.string() })`.
  - Inferred types `ShellRun`, `ShellView`, `ShellSize` exported beside their schemas.
  - `chat.open`'s result gains `shell: ShellViewSchema.optional()`.
  - `MoveBusySchema` gains `'command'` (older desktops don't validate results; they just show no reason text).

- [ ] **Step 1: Write the failing tests** in `shell.test.ts`:
  - `PROTOCOL_VERSION is 13 and the remote range is 12..14`;
  - `SHELL_CAPABILITY is 'shell' and not in CAPABILITIES`;
  - `shell.* methods and events are listed`;
  - `shell.start refuses an empty or whitespace command and one over SHELL_COMMAND_MAX`;
  - `shell.input refuses data over SHELL_INPUT_MAX, and the error message doesn't contain the data` (data `'hunter2'.repeat(10_000)`);
  - `sizes outside 2..1000 × 2..500 are refused`;
  - `chat.open parses with and without shell`;
  - `move busy accepts 'command'`.
  - Update the old pins (11..13 → 12..14, 12 → 13) and the fixture's samples (11, 12, 14, 15).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol exec vitest run`. Expect FAIL.
- [ ] **Step 3: Implement.** `version.ts` gets the line `13 — ! commands: shell.start, .input, .resize, .stop, .get, the shell.run and shell.output events, shell on chat.open, 'command' as a move busy reason, the shell capability.` Add the Rust constants and the `REFUSED` entries, then regenerate the core's answers with `THREADGARDEN_WRITE_FIXTURES=1 cargo.exe test --test contract` in `apps/desktop/src-tauri/core` (the cargo PATH recipe from memory).
- [ ] **Step 4: Run** the protocol tests, `cargo.exe test` in `apps/desktop/src-tauri/core`, `cargo.exe test protocol_version` in `apps/desktop/src-tauri`, and the desktop `tests/state/machines.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat(protocol): protocol 13 for ! commands`.

### Task 3: Terminal text and the shell line

**Files:**
- Create: `packages/service/src/shell/terminal-text.ts`, `packages/service/src/shell/shell-line.ts`
- Test: `packages/service/test/shell/terminal-text.test.ts`, `packages/service/test/shell/shell-line.test.ts`

**Interfaces:**
- Consumes: the Task 1 constants.
- Produces:
  - The spike's answers as code, each with a comment pointing at the results doc: `export const OUTPUT_LIMIT: number`, `export const CUT_NOTE: string`, `export const ENTRY_SHAPE: 'one' | 'two'`, `export const TAGS_ESCAPED: boolean`, `export const ECHOES: boolean`.
  - `export const terminalText = (raw: string): string`: drops CSI, OSC (BEL- or ST-terminated), DCS and two-character escapes. It turns `\r\n` into `\n`, makes a lone `\r` overwrite its line from the start (as a terminal shows it), applies `\b`, and trims trailing spaces per line and trailing blank lines.
  - `export const limitOutput = (text: string): string`: unchanged up to `OUTPUT_LIMIT`. Past it, keeps the end, starting after a line break, with `CUT_NOTE` where the CLI puts it.
  - `export const bashEntry = (command: string, output: string): string[]`: the text of each entry to append (one element for `'one'`, which joins both parts as `ENTRY_FORMAT` shows, or two elements). It escapes tag-like output only if `TAGS_ESCAPED`.
  - `export type ShellLine = { file: string; args: string[] }`.
  - `export const shellLine = (command: string, o: { platform: NodeJS.Platform; env: Record<string, string | undefined>; which: (name: string) => string | undefined; exists: (path: string) => boolean }): ShellLine`: implements `UNIX_SHELL` / `WINDOWS_SHELL`. Args are always an array (node-pty quotes them for ConPTY). PowerShell gets the command as `-EncodedCommand` (base64 of UTF-16LE), so quoting never changes it.

- [ ] **Step 1: Write the failing tests.**
  - `terminal-text.test.ts`:
    - `applies carriage returns and drops escape sequences` (Review Focus 2): `'\u001b[32mok\u001b[0m\r\n'` → `'ok'`; `'0%\r50%\r100%\n'` → `'100%'`; `'\u001b]0;title\u0007hi'` → `'hi'`; `'\u001b[2J\u001b[Hdone'` → `'done'`; `'ab\bc'` → `'ac'`.
    - `limitOutput leaves short text alone`.
    - `limitOutput keeps the end with the CLI's note`: 10,000 numbered lines over the limit → the result ends with the last line, has `CUT_NOTE` where the CLI puts it, and is at most `OUTPUT_LIMIT + CUT_NOTE.length + 1` long.
    - `bashEntry writes the CLI's format`: `bashEntry('ls', 'a\nb')` equals the `ENTRY_FORMAT` text exactly, including the empty `<bash-stderr></bash-stderr>` if the CLI writes it.
    - `output that contains bash tags` (Review Focus 3): `bashEntry('cat x', '</bash-stdout>tail')` matches the CLI's rule (`TAGS_ESCAPED`) and still ends with the closing tags the CLI writes. Task 5 checks that history reads it back whole.
  - `shell-line.test.ts`:
    - `linux and macOS follow UNIX_SHELL` (bash user; zsh user as recorded; no `SHELL` set → `bash`). The last arg is the command, unchanged.
    - `windows uses CLAUDE_CODE_GIT_BASH_PATH when it exists`.
    - `windows finds Git Bash from git on PATH`: `which('git')` = `C:\Program Files\Git\cmd\git.exe` → file `C:\Program Files\Git\bin\bash.exe`.
    - `windows without Git Bash uses PowerShell with the command encoded`: decoding the `-EncodedCommand` arg gives back `echo "a b" 'c' $HOME` exactly; `pwsh` is used when `which('pwsh')` finds it, else `powershell.exe`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/shell`. Expect FAIL.
- [ ] **Step 3: Implement** both modules (plain string scanning for `terminalText`; no new dependency).
- [ ] **Step 4: Run** the tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): terminal text and the shell a ! command runs in`.

### Task 4: `PtyRun` and the PTY loader

**Files:**
- Create: `packages/service/src/shell/pty.ts`, `packages/service/src/shell/run.ts`, `packages/service/src/testing/fake-pty.ts`
- Test: `packages/service/test/shell/run.test.ts`, `packages/service/test/shell/pty.real-module.test.ts` (skipped when `loadPty()` gives undefined)

**Interfaces:**
- Consumes: Task 2 schemas and constants, Task 3 functions, `Timers` from `chat/live-session.ts`.
- Produces:
  - `pty.ts`:
    ```ts
    export interface PtyProcess { readonly pid: number; onData(cb: (data: string) => void): void; onExit(cb: (e: { exitCode: number; signal?: number }) => void): void; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void }
    export type PtyFactory = (file: string, args: string[], o: { cwd: string; cols: number; rows: number; env: Record<string, string>; name: 'xterm-256color' }) => PtyProcess;
    export const loadPty = async (log: { warn(m: string): void }): Promise<PtyFactory | undefined>; // dynamic import of PTY_PACKAGE; undefined (one warning) when it can't load
    ```
  - `fake-pty.ts`: `class FakePty implements PtyProcess` (records `spawned: {file, args, o}`, `written: string[]`, `resizes`, `kills`; `emit(data)`, `exit(code, signal?)`; `echo = false` by default, like a password prompt) and `fakePtyFactory(): { factory: PtyFactory; last(): FakePty }`. The mock (Task 8) and the tests use it.
  - `run.ts`:
    ```ts
    export const SHELL_COALESCE_MS = 50, SHELL_CHUNK_MAX_CHARS = 65_536, SHELL_RATE_CHARS_PER_S = 524_288, SHELL_STOP_GRACE_MS = 3_000, SHELL_TRANSCRIPT_TAIL_CHARS = 1_048_576;
    export const SKIP_MARKER = '\r\n\u001b[2m[… output skipped here: too fast to show …]\u001b[0m\r\n';
    export type ShellRunEnd = { exitCode: number | null; reason: 'exit' | 'stopped' | 'session'; durationMs: number; transcript: string };
    export class PtyRun {
      constructor(init: { runId: string; sessionId: string; command: string; cwd: string; cols: number; rows: number; env: Record<string, string | undefined> },
                  deps: { pty: PtyFactory; line: (command: string) => ShellLine; emit(e: EventMsg): void; now(): number; timers: Timers; onEnd(end: ShellRunEnd): void });
      get info(): ShellRun /* protocol */; get running(): boolean;
      view(): { output: string; offset: number };
      write(data: string): void; resize(cols: number, rows: number): void;
      stop(): void;      // '\x03' now, kill after SHELL_STOP_GRACE_MS if it hasn't exited; state 'stopping'
      kill(): void;      // at once; ends with reason 'session'
      markAppended(entryId: string): void; // sets info.entryId, emits shell.run
    }
    ```
    How it behaves:
    - The constructor spawns `deps.line(command)` with `cwd`, the size, and `env` plus `TERM=xterm-256color` and `COLORTERM=truecolor` (undefined values dropped). It emits `shell.run` (`running`). If the spawn throws, that becomes `ServiceError('SHELL_FAILED', <message>)`.
    - Output is buffered and emitted as `shell.output` at most every `SHELL_COALESCE_MS`, in chunks of at most `SHELL_CHUNK_MAX_CHARS`. `offset` counts emitted characters.
    - Within each 1-second window, characters beyond `SHELL_RATE_CHARS_PER_S` are dropped from the live stream, and `SKIP_MARKER` is emitted once per skip.
    - The scrollback keeps the last `SHELL_SCROLLBACK_CHARS` emitted characters, cut at a line break.
    - Separately, the last `SHELL_TRANSCRIPT_TAIL_CHARS` raw characters are kept (rate cap or not, cut at a line break) for `transcript = limitOutput(terminalText(tail))`.
    - On exit it flushes, sets `state: 'ended'`, `endedAt`, `exitCode` (null for a signal) and `endReason` (`stopped` if `stop()` was called), emits `shell.run`, then calls `onEnd`.
    - `write`, `resize` and `stop` after the end throw `ServiceError('SHELL_NOT_RUNNING', 'The command has ended')`. None of them logs or emits the input.

- [ ] **Step 1: Write the failing tests** in `run.test.ts` (FakePty, fake timers):
  - `starts the shell line in the chat's folder with the size and TERM`;
  - `coalesces output into chunks with running offsets` (three `emit`s in 20 ms → one event at offset 0; the next event's offset is the first one's length);
  - `a flood is rate-capped and the transcript keeps the end` (Review Focus 1): 5 MB in 100 KB pieces within 1 s → emitted data ≤ `SHELL_RATE_CHARS_PER_S + SHELL_CHUNK_MAX_CHARS + SKIP_MARKER.length`, the marker appears, `view().output.length ≤ SHELL_SCROLLBACK_CHARS`, and after `exit(0)` the end's `transcript` ends with the last line written and contains `CUT_NOTE`;
  - `attach mid-run continues from the scrollback's offset` (Review Focus 4): after 400 KB, `view()` gives `offset + output.length` = total emitted, and the next event's `offset` equals that;
  - `input reaches the PTY and is never recorded`: `write('hunter2\r')` → `written` has it; no emitted event, `info`, `view()` or the end's `transcript` contains `hunter2`;
  - `stop sends Ctrl+C, then kills after the grace period`: `written` ends with `'\x03'`, state `stopping` is emitted, `kills` stays empty until 3,000 ms pass, then one kill; with `exit(130)` before that, no kill. The end has `reason: 'stopped'`;
  - `resize resizes the PTY and re-emits the run with its size`;
  - `exit reports code, duration and the cleaned transcript`;
  - `kill ends at once with reason session`;
  - `a spawn failure is SHELL_FAILED`;
  - `after the end, write, resize and stop say SHELL_NOT_RUNNING`.
  - `pty.real-module.test.ts`: `runs a real command in a PTY` (`echo tg-$((1+1))` through `shellLine` → output has `tg-2`, exit 0).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/shell`. Expect FAIL.
- [ ] **Step 3: Implement** `pty.ts`, `fake-pty.ts`, `run.ts`.
- [ ] **Step 4: Run** the tests (the real-module test runs here on Windows). Expect PASS.
- [ ] **Step 5: Commit** `feat(service): run a command in a pseudo-terminal`.

### Task 5: The chat owns its command

**Files:**
- Modify: `packages/service/src/chat/live-session.ts`, `packages/service/src/chat/session-host.ts`, `packages/service/src/chat/normalize.ts` (`cliUserMessage`, a `parseShellEntry` beside `parseCommandOutput`), `packages/service/src/server/handlers/move.ts` (`busyOf`)
- Test: `packages/service/test/chat/live-session.test.ts`, `packages/service/test/chat/session-host.test.ts`, `packages/service/test/chat/normalize.test.ts`, `packages/service/test/move/transfer.test.ts` (or wherever `busyOf` is tested)

**Interfaces:**
- Consumes: Tasks 2–4 (`PtyRun`, `bashEntry`, `ENTRY_SHAPE`, `ECHOES`); piece 1's `restartWhenFree`.
- Produces:
  - `LiveSessionDeps.shell?: { pty: PtyFactory; line: (command: string) => ShellLine }`. Without it, or for a Codex session, starting is `ServiceError('SHELL_UNSUPPORTED', '! commands are for Claude chats')`. `SessionHost`'s deps take it and pass it through like the other hooks.
  - `LiveSession.startCommand(command: string, size: { cols: number; rows: number }): ShellRun /* protocol info */`. It throws `NOT_LIVE` with no process and `SHELL_BUSY` (`A command is already running in this chat`) while one runs: one command per chat at a time. The run uses `deps.env`, the same environment as the chat's Claude process.
  - `LiveSession.command(): ShellView | undefined` (the running or last run of this instance) and `LiveSession.commandRun(runId): PtyRun | undefined` (the run object, for input, resize and stop).
  - `get runningCommand(): boolean`. `runningTasks` and `runningAgents` each add 1 while it's true. `onRunningTasks` is called on start and end.
  - On a normal end, while the process is live: build `bashEntry(command, end.transcript)` and send each entry as `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid, shouldQuery: false }`. There's no `priority` unless the spike says the CLI needs one. Then call `noteActivity()`. If `ECHOES` is false, push the items yourself by running the same SDK message through `this.normalizer`, so live and history render alike. Then `markAppended(<the ! line's item id>)`. Status, `queued`, `onTurnEnded` and `chatFinished` stay untouched.
  - `stop()` (end, pause, stop all) and the pump's crash path call `run.kill()` before anything else, so nothing is appended. The run belongs to the chat, not its process: piece 1's in-place restart (`restartWhenFree`) leaves it running and counts only process tasks (`publishedRunning`) when deciding whether to wait.
  - `SessionHost.commandRun(runId): PtyRun | undefined` searches its live sessions.
  - `normalize.ts`: a user message whose text (blocks joined with `\n`) is `<bash-input>X</bash-input>` followed by output blocks gives the user item `! X` (the message id) and, when the output isn't empty, a system item with id `${id}:out` (level `warning` when stderr has text). The two-message form already handled stays as it is. The output match runs to the **last** `</bash-stdout>`, then an optional trailing `<bash-stderr>…</bash-stderr>`.
  - `busyOf` checks `runningCommand` after `prompt` and before `subagents`, and returns `'command'`. Its argument type gains `runningCommand: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `live-session.test.ts` (FakeAdapter, `fakePtyFactory`):
    - `a command's end appends one shouldQuery false message`: `adapter.lastSession.sent` ends with message(s) per `ENTRY_SHAPE`, all with `shouldQuery: false`. Status stays `idle`, and no `chatFinished` or `working` status is emitted;
    - `the appended entry renders as ! command and an output line` (user `! ls` with id = the message uuid, system `${uuid}:out`; the run's `entryId` is that uuid);
    - `a command during a turn leaves the turn alone` (status stays `working` until the `result`; `queued()` stays empty);
    - `a running command counts as a running task and agent` (and `onRunningTasks` gets 1, then 0);
    - `one command at a time` (`SHELL_BUSY`);
    - `Codex chats and services without a PTY refuse` (`SHELL_UNSUPPORTED`);
    - `end stops the command and appends nothing` (`endReason: 'session'`, no `shouldQuery` message sent);
    - `a crashed session stops its command` (Review Focus 5): the fake session's stream throws mid-run → the PTY is killed, nothing is appended, and `shell.run` is emitted with `endReason: 'session'`;
    - `an MCP restart leaves a running command alone` (`restartWhenFree({ stopTasks: false })` with only a command running restarts at once; the run goes on and its end is appended to the new process).
  - `session-host.test.ts`: `reclaim spares a chat running a command`; `list counts a running command in runningTasks and runningAgents`; `stopAll stops commands`; `commandRun finds a run by id`.
  - `normalize.test.ts`: `renders a ! entry with its output in one message`; `output containing </bash-stdout> is kept whole` (Review Focus 3); `an empty output gives only the ! line`. Keep `renders shell input and command output like the terminal` passing.
  - `busyOf`: `a running command makes a chat busy with 'command'` (and a turn still wins over it).
- [ ] **Step 2: Run** the chat and move tests. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole service suite (idle reclaim, queued messages, tasks, power idle and move tests must still pass). Expect PASS.
- [ ] **Step 5: Commit** `feat(service): a chat runs one ! command and appends its output`.

### Task 6: The `shell.*` handlers and the service wiring

**Files:**
- Create: `packages/service/src/server/handlers/shell.ts`
- Modify: `packages/service/src/server/handlers/chat.ts` (return `resumedOrLive` and `activate` from `registerChatHandlers`; `chat.open` adds `shell: s.command()` when there is one), `packages/service/src/main.ts`
- Test: `packages/service/test/server/shell-handlers.test.ts`, `packages/service/test/main.test.ts` (hello)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `registerShellHandlers(router: Router, deps: { host: SessionHost; resumedOrLive: (sessionId: string) => Promise<LiveSession>; activate: (sessionId: string) => void; isMoving?: (id: string) => boolean; awayTo?: (id: string) => { name: string } | undefined }): void`.
  - `startService` options gain `shell?: { pty: PtyFactory | null; line?: (command: string) => ShellLine }`. `pty: null` disables the feature; with the option absent, `loadPty(log)` runs at start. `line` defaults to `shellLine` with the real platform, env, `which` and `existsSync`. With a factory, both `capabilities` branches add `SHELL_CAPABILITY` and the host gets `shell`.

Behaviour:
- `shell.start`:
  - A Codex session id → `SHELL_UNSUPPORTED`. Moving → `MOVING`; moved away → `MOVED` (the same texts as `chat.send`).
  - Otherwise `await resumedOrLive(sessionId)`: runnable, a `blocked` resume check → `RESUME_BLOCKED`, the same moved/moving refusals.
  - Then `activate(sessionId)` and `startCommand(command, {cols, rows})`, which returns the run.
- `shell.input`, `shell.resize`, `shell.stop`: `host.commandRun(runId)`, else `SHELL_NOT_RUNNING`. Every failure is a `ServiceError`, so the router never logs it, and no message contains `data`.
- `shell.get`: `{ view: host.get(sessionId)?.command() ?? null }`.

- [ ] **Step 1: Write the failing tests** (`startService` over FakeAdapter with `shell: { pty: fake.factory, line: (c) => ({ file: 'sh', args: ['-c', c] }) }`, as in `chat-handlers.test.ts`):
  - `start resumes a paused chat and runs the command in its folder` (the session starts with `resume`; the fake PTY's `cwd` is the chat's);
  - `start honours a blocked resume check` (`RESUME_BLOCKED`; no PTY spawned);
  - `start refuses a Codex chat, a moving chat and a moved chat`;
  - `output and the end reach clients as events; the end is appended`;
  - `input, resize and stop go to the run; an unknown run is SHELL_NOT_RUNNING`;
  - `never logs or echoes input`: `shell.input` with `hunter2` (to a live run, to an unknown run, and too long). The router's log, `onError`, every event sent to a client, the database file's bytes and the appended text contain no `hunter2`;
  - `get and chat.open return the run, its scrollback and offset; nothing for a chat without one`;
  - `service shutdown kills a running command without appending`;
  - `hello advertises shell only with a PTY` (local and headless; `pty: null` → no `shell`).
- [ ] **Step 2: Run** the server tests. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole service suite and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(service): shell.* methods and the shell capability`.

### Task 7: Packaging the PTY module

**Files:**
- Modify: `packages/service/scripts/build.mjs` (`external: [PTY_PACKAGE]`; after bundling, copy `PTY_FILES` for `--pty-target <platform>-<arch>` (default: the host) into `dist/node_modules/`, dereferencing links; fail naming the missing package when that target's binary isn't installed; update the doc comment)
- Modify: `scripts/build-headless.mjs` (build the service with `--pty-target linux-<arch>` / `win32-x64`; copy `dist/node_modules` to `lib/node_modules`), `apps/desktop/src-tauri/tauri.bundle.conf.json` (resource `../../../packages/service/dist/node_modules/` → `service/node_modules/`), `packages/protocol/src/update.ts` (the frozen-layout comment notes `lib/node_modules/` as an addition, protocol 13), `CONTRIBUTING.md` (the zip contents)
- Modify: `.github/workflows/ci.yml` (Windows package check lists the PTY binary path; a Linux tarball check with `tar -tzf`; on each OS of the check matrix a step "PTY smoke under the sidecar Node": fetch the host's sidecar with `--out`, build the service, run `scripts/pty-smoke.mjs packages/service/dist`), `.github/workflows/release.yml` (the same smoke in `bundle`, `headless` and `headless-windows` before upload, against what was packaged)
- Test: `packages/service/test/packaging/install.test.ts`, `packages/service/test/packaging/install-windows.test.ts`, `packages/service/test/build.test.ts` (create if there's no build test; it runs `build.mjs` into a temp out dir)

**Interfaces:**
- Consumes: Task 1 constants, Task 4 `loadPty`.
- Produces: `dist/node_modules/<PTY_PACKAGE>/…` beside `dist/service.mjs` (debug builds also resolve it from `packages/service/node_modules`), `service/node_modules/…` in the desktop bundles, and `lib/node_modules/…` in both headless packages.

- [ ] **Step 1: Write the failing tests.**
  - `build.test.ts`: `the bundle leaves the PTY package external` (`dist/service.mjs` contains an import of `PTY_PACKAGE` and none of its sources); `the host's PTY files sit beside service.mjs` (every `PTY_FILES` entry for the host exists under `dist/node_modules`; on macOS `spawn-helper` is executable); `a missing target fails with its package name`.
  - `install.test.ts`: `install keeps lib/node_modules beside service.mjs` (a fake release with `lib/node_modules/<pkg>/x.node` → present under `<base>/9.9.9/lib/node_modules`).
  - `install-windows.test.ts`: the same for the zip layout.
- [ ] **Step 2: Run** the packaging and build tests. Expect FAIL.
- [ ] **Step 3: Implement** the scripts, the Tauri resource and the CI steps.
- [ ] **Step 4: Run** the tests. Then `node scripts/build-headless.mjs --platform windows` and unpack the zip to a temp dir. Run `<tmp>/bin/node.exe scripts/pty-smoke.mjs <tmp>/lib`; expect `[pty-smoke] ok win32-x64`. Then `pnpm --config.verify-deps-before-run=false --filter desktop tauri build --config src-tauri/tauri.bundle.conf.json --debug --bundles nsis` if the toolchain allows: the installed app's `service/node_modules` holds the PTY files. Push the branch and check the new CI smoke steps pass on Windows, macOS and Ubuntu (macOS arm64 is checked only there).
- [ ] **Step 5: Commit** `build: ship the PTY module beside the service`.

### Task 8: A fake terminal in the mock

**Files:**
- Modify: `packages/service/src/testing/mock-main.ts` (doc comment; `startService({ shell: { pty: mockPty, line: (c) => ({ file: 'mock-sh', args: ['-c', c] }) } })` for both mocks; `ScriptedSession.send` for `shouldQuery: false`)
- Test: `packages/service/test/testing/mock-main.test.ts`

**Interfaces:**
- Consumes: `FakePty` (Task 4).
- Produces: `mockPty: PtyFactory`, which scripts by command:
  - `sudo …` prints `[sudo] password for mock: `, waits for `\r` without echoing, then prints `Reading package lists... Done` and `Do you want to continue? [Y/n] ` (echoing). `y` or Enter runs a coloured progress bar redrawn with `\r` from 0 to 100% over about 1.5 s, then prints `Done.` and exits 0. `n` prints `Abort.` and exits 1;
  - `sleep N` waits N s. `\x03` prints `^C` and exits 130;
  - `ignore-int` ignores `\x03` (for the kill after the grace period);
  - `flood` writes 3 MB of numbered lines as fast as it can;
  - `exit N` exits N;
  - `ls` prints coloured names;
  - anything else prints `mock: ‹command›` and exits 0.

  `ScriptedSession` starts no turn for a `shouldQuery: false` message. It remembers the first command in it, and the next turn's reply begins `I can see the output of \`! ‹command›\`.`

- [ ] **Step 1: Write the failing tests:**
  - `a ! command runs in the mock terminal and its output reaches the next reply`;
  - `sudo asks for a password and never shows it` (the password isn't in `shell.output`, `chat.items` or the appended text);
  - `the remote mock offers shell` (hello capabilities).
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the service suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(mock): a fake terminal for ! commands`.

### Task 9: Shell state in the UI

**Files:**
- Create: `apps/desktop/src/lib/state/shell-output.ts`
- Modify: `apps/desktop/src/lib/state/chats.svelte.ts` (`ChatState.shell`, `running`, events, open, resync, the four actions), `apps/desktop/src/lib/projects.ts` (`supportsShell`)
- Test: `apps/desktop/tests/state/shell.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas and methods.
- Produces:
  - `export class ShellOutput { constructor(limit = SHELL_SCROLLBACK_CHARS); reset(output: string, offset: number): void; push(offset: number, data: string): 'ok' | 'gap'; text(): string; get end(): number; listen(fn: (data: string) => void): () => void }`. Data that ends before `end` is dropped; the overlapping part of a chunk is trimmed. A chunk starting after `end` returns `'gap'`. `reset` notifies listeners with a full redraw (the component clears its terminal first).
  - `ChatState.shell = $state.raw<ShellRun | null>(null)` and `ChatState.shellOutput: ShellOutput` (a plain field, replaced per run). `running` = `runningTasks(tasks) + (shell && shell.state !== 'ended' ? 1 : 0)`.
  - `ChatsState`:
    - handles `shell.run` (a new `runId` replaces the run and its output) and `shell.output` (on `'gap'`, one `shell.get`) for resident chats;
    - applies `chat.open`'s `shell`;
    - in `resync`, after `chat.since`, calls `shell.get` for each chat whose run isn't ended;
    - exposes `startCommand(sessionId, command, size): Promise<ShellRun>`, `commandInput(runId, data)`, `commandResize(runId, size)`, `commandStop(runId)`.
  - `supportsShell(m: MachineEntry | undefined): boolean` (`SHELL_CAPABILITY` in its hello).

- [ ] **Step 1: Write the failing tests** in `shell.test.ts`:
  - `ShellOutput keeps the end and drops repeats` (overlapping chunk trimmed, old chunk ignored, length ≤ limit);
  - `a gap asks for shell.get once`;
  - `shell.run sets the chat's run and counts it as running until it ends`;
  - `chat.open's shell fills the output`;
  - `resync reloads a running command's output` (Review Focus 4): a fake Api reconnects, `shell.get` answers a longer scrollback, `text()` equals it, and later chunks continue from it;
  - `events of other chats and old runs are ignored`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/state/shell.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the desktop typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): keep a chat's running command in state`.

### Task 10: The terminal block

**Files:**
- Create: `apps/desktop/src/lib/components/chat/items/ShellBlock.svelte`, `apps/desktop/src/lib/components/chat/shell-format.ts`
- Modify: `apps/desktop/package.json` + `pnpm-lock.yaml` (`@xterm/xterm`, `@xterm/addon-fit`), `apps/desktop/src/lib/components/chat/rows.ts` (a `shell` row), `apps/desktop/src/lib/components/chat/MessageList.svelte` (render it)
- Test: `apps/desktop/tests/chat/shell-block.test.ts`, `apps/desktop/tests/chat/rows.test.ts`

**Interfaces:**
- Consumes: Task 9.
- Produces:
  - `shell-format.ts`:
    - `shellFooter(run: ShellRun, now: number): string` (the Global Constraints copy, with durations in the Activity panel's format);
    - `shellTitle(run: ShellRun, machineName: string, home: string): string`.
  - `ShellBlock.svelte` props: `{ run: ShellRun; output: ShellOutput; machineName: string; home: string; autofocus?: boolean; onInput: (data: string) => void; onResize: (size: { cols: number; rows: number }) => void; onStop: () => void }`.
    - It has a title bar with `Stop` (or `Stopping…`, disabled) while not ended, an xterm terminal, and the footer.
    - The terminal takes the app's mono font and theme colours (CSS variables, re-read when the theme changes). It shows up to `SHELL_BLOCK_ROWS = 24` rows, then scrolls; scrollback is 5,000 lines.
    - It writes `output.text()` on mount and then each `listen` chunk (clearing on a reset). It renders at the run's `cols` (horizontal scroll when the pane is narrower).
    - `onData` goes to `onInput` only while running. When ended, stdin is disabled.
    - It calls `onResize` with the fitted size at mount when `autofocus` is set (the starter) and while it has focus (on focus and on width change). Another window never resizes a run it isn't using.
  - `rows.ts`: `withShell(rows, run, itemIds)`. When `run.entryId` is among the items, a `shell` row goes right after that user row, and the `${entryId}:out` system row is hidden. Otherwise (running, or ended without being appended) the `shell` row comes last, after the items and before queued messages.

- [ ] **Step 1: Write the failing tests.**
  - `rows.test.ts`:
    - `a running command's block comes last`;
    - `an appended run's block follows its ! line and hides the output line`;
    - `without a run, a ! line and its output render as plain rows` (history).
  - `shell-block.test.ts` (with `vi.mock('@xterm/xterm')` recording `write`, `onData`, `resize`, and `options.disableStdin`):
    - `shows the title with ~ for home`;
    - `Stop calls onStop and then shows Stopping…`;
    - `typing reaches onInput only while running`;
    - `writes the scrollback, then new output; a reset clears first`;
    - `resizes at start for the starter and while focused, not otherwise`;
    - `footer for exit 0, exit 2, stopped, and ended with the session`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/chat/rows.test.ts tests/chat/shell-block.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** (add the two xterm packages with the no-links recipe; import xterm's CSS in the component).
- [ ] **Step 4: Run** the tests, desktop typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): a live terminal block for ! commands`.

### Task 11: Command mode in the composer, and the chat's wiring

**Files:**
- Modify: `apps/desktop/src/lib/components/composer/Composer.svelte` (`onCommand`, `commandLabel` props; command mode), `apps/desktop/src/lib/components/composer/tags.ts` (`commandText`), `apps/desktop/src/lib/components/chat/ChatView.svelte` (pass `onCommand`; `ShellBlock` callbacks), `apps/desktop/src/lib/components/chat/end-session.ts` + `ChatHeader.svelte` (End session warns about a running command), `apps/desktop/src/lib/components/MoveChatDialog.svelte` (`busy === 'command'`)
- Test: `apps/desktop/tests/interaction/composer.test.ts`, `apps/desktop/tests/chat/shell-chat.test.ts`, the End session warning test (`end-session` tests where they are)

**Interfaces:**
- Consumes: Tasks 9–10; piece 1's `withResumeCheck(run: () => Promise<boolean>)` in `ChatView.svelte`.
- Produces:
  - `commandText(text: string, state: AttachmentsState): string`: the text after the leading `!`, with `[Image #N]` tags removed and paste tags replaced by their pasted text, trimmed. The spec's "images and file tags are not sent": the composer's tags are image and paste tags, and a paste is text the user means to run.
  - `Composer` props: `onCommand?: (command: string) => Promise<boolean>` (resolves true when it started; throws to show its message as the notice) and `commandLabel?: string`.
    - With `onCommand` set and the text starting with `!` (after leading spaces), the box is in command mode: `data-command-mode` on the box, a tint, and a leading chip reading `!` titled `commandLabel`. The slash menu stays closed.
    - Submit sends `commandText` to `onCommand`. Images are never sent. An empty command shows `Type a command after !`.
    - Without `onCommand`, nothing changes: `!` is text.
  - `ChatView` passes `onCommand` when `!isCodexChat(sessionId)` and the chat isn't a moved-away copy, with `commandLabel` = `Runs in a terminal on ‹machine›, in this chat's folder`. The handler:
    - while `machineAway`, throws `` `${awayAs}, so the command can't run there.` ``;
    - without `supportsShell(entry)`, throws `Update ‹machine› to run ! commands here.`;
    - otherwise `withResumeCheck(() => chats.startCommand(sessionId, command, SHELL_DEFAULT_SIZE).then(() => true))`, then focuses the new block (`autofocus` on the starter's block).
  - `endSessionWarning` gains `command?: string`. When set, the description starts with `` `! ${command}` is still running; ending the session stops it. `` followed by the existing text, or by `after` alone when nothing else runs. `ChatHeader` passes `chat.shell?.command` while the run isn't ended.
  - `MoveChatDialog`: `busy === 'command'` reads `A ! command is running in this chat; moving it stops the command.`, and its Stop calls `commandStop(chat.shell.runId)` and checks again.

- [ ] **Step 1: Write the failing tests.**
  - `composer.test.ts`:
    - `a leading ! turns on command mode and sends the command, not a message`;
    - `images and image tags are left out; pasted text runs`;
    - `! alone says Type a command after !`;
    - `without onCommand a leading ! is sent as text` (New chat and Codex);
    - `/ inside a command opens no slash menu`.
  - `shell-chat.test.ts` (ChatView harness as in `remote-chat.test.ts`):
    - `! in a Claude chat starts a command through the resume check` (`unverified` asks first, `blocked` shows the blocked banner, `ok` calls `shell.start` with the folder's chat);
    - `! in a Codex chat is sent as a message`;
    - `an away machine says it is off`;
    - `an old machine says to update it`;
    - `the block appears and Stop stops it`;
    - `the chat counts as running while the command runs`.
  - End session: `warns about a running command`.
- [ ] **Step 2: Run** the desktop tests named above. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole desktop suite, typecheck and lint. Expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): ! command mode in the chat`.

### Task 12: End to end, docs, hardware check, wrap-up

**Files:**
- Create: `apps/desktop/e2e/shell.spec.ts`
- Modify: `docs/architecture.md`, `README.md` (a feature line), `packages/service/README.md` (the `shell/` module, `test:real` gains `shell.real.test.ts`)

- [ ] **Step 1: Write `shell.spec.ts`** against the mock:
  - `! sudo apt upgrade takes a password and y, and ends with exit 0`. The password typed into the block isn't visible in the block, in the chat or after a reload. The `! sudo apt upgrade` line and its output line are in the chat; the footer reads `✓ exit 0 ·`;
  - `the next message carries the output to Claude` (the reply starts `I can see the output of`);
  - `Stop ends a sleeping command` (`! sleep 60` → `Stopped ·`), and `ignore-int` is killed after the grace period;
  - `a command keeps running when its tab closes and redraws when reopened`;
  - `a flood stays responsive` (`! flood`: the skipped marker shows; typing in the composer still works);
  - `New chat sends ! as text`;
  - `the phone layout runs a command and stops it with the button`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop test:e2e shell` (if Chromium is installed), then `interface-size` and `screenshots`. Check every screenshot for real data (memory `readme-screenshots-no-real-data.md`).
- [ ] **Step 3: Write the docs.**
  - `architecture.md`: protocol 13 in Lifecycle → Versions and in Protocol (methods, events, capability, the range).
  - `architecture.md`, a "`!` commands" paragraph under Live chats: the PTY, the shell rule, one command per chat, the scrollback, coalescing and the rate cap, the append with `shouldQuery: false` in the CLI's format and limit, reclaim and idle-shutdown rules, what ends a command.
  - `architecture.md` Security model: input is forwarded, never recorded.
  - `architecture.md` Verified against the real Claude Code: the spike's findings.
  - Packaging: where the PTY files ship.
- [ ] **Step 4: Run** the full protocol, service and desktop suites. Expect PASS.
- [ ] **Step 5: Commit** `docs: ! commands in the chat`.
- [ ] **Step 6: Hardware check with the owner.**
  - Update wobble from Settings to a build of this branch. From the desktop: `! sudo apt upgrade` (password, `y`), `! gh auth status`, `! git status`. From the phone: the same, locking the screen mid-run and unlocking (the block redraws).
  - On wobble, `claude --resume <id>` in a terminal: the entries look like the CLI's own.
  - The machine doesn't power off at idle while `! sleep 900` waits.
  - On This PC (Windows) and the native Windows worker, `! echo $0` shows Git Bash.
  - Record the results in the spike results doc's last section.
- [ ] **Step 7:** Update the vault (`git pull` first). Mark `!` commands done in whichever `Threadgarden/` note lists it (the hub's "Now" or `Remote machines.md`), and add follow-ups found here (for example a terminal panel, still in *To decide*). Commit and push the vault.
- [ ] **Step 8:** Rebase on `main` once piece 1 has merged (apply the renumber rule if it hasn't). Open the PR into `main`.

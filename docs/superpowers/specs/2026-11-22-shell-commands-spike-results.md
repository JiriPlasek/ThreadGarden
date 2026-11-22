# `!` commands: spike results

Date: 2026-11-22. This covers Task 1 of the plan for [the `!` commands design](2026-11-22-shell-commands-design.md): a PTY package that runs under the bundled Node on every target, and what the real Claude Code does with `!` entries. Format follows [the move-chat spike](2026-11-02-move-chat-spike-results.md).

## The test

**Tools:** `scripts/pty-smoke.mjs` (loads the package from a `node_modules` folder and runs `echo tg-pty-$((40+2))` in a PTY), and the opt-in real test `packages/service/test/real/shell.real.test.ts` (C1 to C5, `THREADGARDEN_REAL=1`). The real test drives the interactive `claude` in a PTY with the same package, and uses `RealAdapter` for the SDK checks. Reading the transcript's raw JSONL lines is spike-only: the product never opens transcripts.

**Versions:** Node 22.23.4 (the `threadgarden-node` sidecar, fetched with `scripts/fetch-node-sidecar.mjs`), Agent SDK 0.3.314. Claude Code auto-updated during the spike: C1 first ran on 2.1.318, everything after on 2.1.330. The results below were identical on both where both ran (C1).

**Where:** This PC (Windows 11 x64, Git for Windows installed, no `pwsh`). Linux checks ran in WSL Ubuntu (x86_64), not on kumbal (no SSH key from here); `claude` is not installed in WSL, so the Linux real-CLI checks are deferred (see "Not done"). macOS arm64 is left to CI (Task 7).

**Test hygiene:** the shell this spike was launched from sets `CLAUDE_CODE_CHILD_SESSION` and friends. With them an interactive `claude` prints "Transcript saving is off" and writes no transcript. The test strips the inherited `CLAUDE_*` markers before starting any CLI (what the service sees when started by the desktop app or systemd). The CLI also asks "do you trust this folder" in a fresh temp folder, with **"No, exit" highlighted** in 2.1.318 and later, so the test sends Down then Enter.

## The package (steps 1 and 2)

| Package | Version, date | Prebuilt binaries | N-API | Licence | Verdict |
|---|---|---|---|---|---|
| `@lydell/node-pty` | 1.2.0-beta.18, 2026-10-24 (npm `latest` tag; the whole line is `1.2.0-beta.N`, active since 2026-01) | per-platform packages, all with the same version: `win32-x64`, `win32-arm64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` | yes (`napi_*` symbols) | MIT | **chosen** |
| `node-pty` | 1.1.0, 2026-10-23 | `darwin-arm64/x64`, `win32-arm64/x64` only; **no linux** | n/a | MIT | fails the gate alone |
| `@homebridge/node-pty-prebuilt-multiarch` | 0.15.0, 2026-10-29 | all of the above plus `linux-x64/arm64/arm`, `linux-musl-*`, `linux-ia32` in one 6.4 MB package | yes | MIT | works; fallback |

**The gate passes:** `@lydell/node-pty` has prebuilt binaries for win32-x64, darwin-arm64 and linux-x64 (and the arm variants). No compiler is needed anywhere. The one caveat is that the npm `latest` tag is a pre-release number (`1.2.0-beta.18`), so the dependency must be pinned exactly (it is). If it ever stalls, `@homebridge/node-pty-prebuilt-multiarch` is a drop-in with the same API.

**How it loads:** `@lydell/node-pty/index.js` does `require('@lydell/node-pty-' + process.platform + '-' + process.arch)`, so the platform package must sit in `node_modules` by that name, next to the main package. With esbuild's `--external:@lydell/node-pty` that is all the bundle needs: `service.mjs` keeps its `require('@lydell/node-pty')` and finds both folders beside it.

## Packaging results (step 3)

Scratch bundle: esbuild of a one-line entry with `--external:@lydell/node-pty --format=esm --target=node22`, then `node_modules/@lydell/node-pty` and the platform package copied beside it (the `.pdb` files left out), run under the sidecar Node.

| Check | Windows x64 (ConPTY, Git Bash) | Linux x64 (WSL Ubuntu, bash) |
|---|---|---|
| `pty-smoke.mjs`, sidecar Node 22.23.4 | **pass**: `[pty-smoke] ok win32-x64 node v22.23.4` | **pass**: `[pty-smoke] ok linux-x64 node v22.23.4` |
| Ctrl+C (`sleep 30`, write `\x03`) | exits in about 1 s, exit code 512 | exits at once, `signal: 2` |
| Resize (`resize(57, 20)`, then `tput cols; stty size`) | prints `57` and `20 57` | prints `57` and `20 57` |
| Kill (`term.kill()`) | ends in under 100 ms | ends at once, `signal: 1` |
| Kill ends the whole tree | **yes**: `ping -t` under bash, 1 process before, 0 after | **yes**: two `sleep 3333` before, 0 after |
| PowerShell fallback (`powershell.exe -NoLogo -NoProfile -EncodedCommand <b64 UTF-16LE>`) | **pass**: prints `tg-pty-42`, exit 0 (PS 5.1) | n/a |

Other things the spike showed:
- **N-API:** the same binary runs under Node 22.23.4 on both OSes with no rebuild; it does not need `NODE_MODULE_VERSION` 127.
- **Windows `onExit`:** the exit code after Ctrl+C is 512 and after `kill()` is -1073741510 (0xC000013A), so the product should report "stopped" by its own state (it sent the interrupt or kill), not by the code.
- **macOS:** the `darwin-arm64` package carries `spawn-helper` with mode 755 in the tarball; the file must keep its exec bit when copied into the app resources. Not run here (CI, Task 7).
- **Linux:** no `spawn-helper`; only `pty.node`.
- The Windows package is 1.65 MB unpacked (`conpty.dll` and `OpenConsole.exe` included, from `prebuilds/win32-x64/conpty/`); the Linux one 100 KB per binary.

## Results per check (step 4)

| Check | Result | Evidence |
|---|---|---|
| C1 the CLI's own `!` entries | **recorded: two entries** | `! echo tg-c1` writes `<bash-input>echo tg-c1</bash-input>`, then a second user entry `<bash-stdout>tg-c1</bash-stdout><bash-stderr>…</bash-stderr>`. See `ENTRY_FORMAT`. Same on 2.1.318 and 2.1.330. |
| C1 (stderr) | **recorded** | `! ls /nonexistent-tg`: `<bash-stdout></bash-stdout><bash-stderr>ls: cannot access '/nonexistent-tg': No such file or directory\n</bash-stderr>`. Both tags are always written, empty or not. |
| C2 limit | **recorded: 30 000 characters, the start is kept** | 30 000 characters of output pass through unchanged; 30 001 and more become a `<persisted-output>` wrapper holding the first 2 KB. See `OUTPUT_LIMIT`. |
| C2 tags in output | **escaped** | `printf '</bash-stdout>x'` is stored as `<bash-stdout>&lt;/bash-stdout&gt;x</bash-stdout>`. |
| C3 `shouldQuery: false` between turns | **pass** (with a correction to the brief) | No assistant output within 5 s. But the stream does carry frames (`ECHOES`), including one `result` per appended message. The next question was answered with the nonce. |
| C4 `shouldQuery: false` mid-turn | **recorded: the running turn sees it** | Appended 2 s into a `sleep 8` turn. The CLI merged both entries into the running turn after the tool result, and that turn's text quoted the nonce. See `MID_TURN`. |
| C5 the shell | **recorded (Windows only)** | Git Bash 5.2.37, `$0` `/usr/bin/bash`, `$SHELL` `/bin/bash.exe`; login-style PATH. Linux deferred. See `UNIX_SHELL`, `WINDOWS_SHELL`. |

## Constants for the build

- **`PTY_PACKAGE`:** `@lydell/node-pty@1.2.0-beta.18` (exact; MIT; added to `packages/service/package.json` as `"@lydell/node-pty": "1.2.0-beta.18"`).
- **`PTY_PLATFORM_PACKAGES`:** `@lydell/node-pty-win32-x64`, `@lydell/node-pty-darwin-arm64`, `@lydell/node-pty-linux-x64`, all `1.2.0-beta.18`. Also published: `-linux-arm64`, `-win32-arm64`, `-darwin-x64`. pnpm installs only the one that matches the host (optional dependencies with `os`/`cpu`), so a CI build for another target must fetch that package by name (for example `npm pack`), not rely on the lock install.
- **`PTY_FILES`** (copy the whole package folders, so the loader finds them by name; keep them under `node_modules/@lydell/` beside `service.mjs`):
  - all targets: `node_modules/@lydell/node-pty/{index.js,package.json,node-pty.d.ts}` (types are not needed at run time).
  - `win32-x64`: `node_modules/@lydell/node-pty-win32-x64/` with `package.json`, `lib/**` (including `lib/worker/conoutSocketWorker.js`, loaded as a worker file), `prebuilds/win32-x64/conpty.node`, `prebuilds/win32-x64/conpty_console_list.node`, `prebuilds/win32-x64/conpty/conpty.dll`, `prebuilds/win32-x64/conpty/OpenConsole.exe`. The `.pdb` files are not needed.
  - `darwin-arm64`: `node_modules/@lydell/node-pty-darwin-arm64/` with `package.json`, `lib/**`, `prebuilds/darwin-arm64/pty.node` and `prebuilds/darwin-arm64/spawn-helper` (**must stay executable**, mode 755).
  - `linux-x64`: `node_modules/@lydell/node-pty-linux-x64/` with `package.json`, `lib/**`, `prebuilds/linux-x64/pty.node` (mode 644 is fine).
- **`PTY_NAPI`:** N-API. The same binaries ran under Node 22.23.4 on Windows and Linux; they do not need to match `NODE_MODULE_VERSION` 127. A later Node bump needs no rebuild.
- **`ENTRY_SHAPE`:** `'two'`. The CLI writes the command and its output as two separate user entries.
- **`ENTRY_FORMAT`** (from the transcript, CLI 2.1.318 and 2.1.330):
  1. `<bash-input>COMMAND</bash-input>`
  2. `<bash-stdout>STDOUT</bash-stdout><bash-stderr>STDERR</bash-stderr>`
  - Entry 2 always holds both tags; an empty one is written as `<bash-stderr></bash-stderr>` (with `queueTranscriptOnly`, see below, and for `! ls /nonexistent`, `<bash-stdout></bash-stdout>`).
  - Neither entry has `isMeta` (the CLI's `<local-command-caveat>` and `/exit` entries around them do). Entry 1 has no `turnOrigin`; entry 2 has `turnOrigin: "human"` and a `turnPosition`. Both carry `promptId`, `userType: "external"`, `entrypoint: "cli"`.
  - Output text is HTML-escaped inside the tags: `<` becomes `&lt;` and `>` becomes `&gt;` (`TAGS_ESCAPED` = **yes**; `&` was not tested).
  - On Windows, the CLI appends `\nShell cwd was reset to <project folder>` to `<bash-stderr>` of a successful command in these runs (not for the failing `ls`). That note is the CLI's own cwd tracking, not output; the build writes only the command's output.
  - The `getSessionMessages` view of both entries is the same two user messages with those strings as `message.content`.
  - Entries appended through the SDK with `shouldQuery: false` (C3) land as user entries with the content exactly as sent, plus `queueTranscriptOnly: true`, `promptSource: "sdk"`, `entrypoint: "sdk-ts"` and no `isMeta`. They chain by `parentUuid` into the next turn.
- **`OUTPUT_LIMIT`:** 30 000 characters (the Bash tool's own limit): exactly 30 000 passed, 30 001 was wrapped. **`CUT_NOTE`:** not a note inside the text but a wrapper, and it keeps the **start**:
  ```
  <persisted-output>
  Output too large (39.1KB). Full output saved to: <config dir>\projects\<project>\<session id>\tool-results\<id>.txt

  Preview (first 2KB):
  <the first 2 KB of the output>
  ...
  </persisted-output>
  ```
  (all inside `<bash-stdout>`). The "2KB" preview was 2 268 characters for `seq` output in the wrapper, and the size reads `1.2MB`, `39.1KB`, `29.3KB` (units in KB or MB). The CLI saves the full output to a file under its own config dir, which Threadgarden must not do (hard rule: never write under `~/.claude`); see finding 2.
- **`ECHOES`:** a `shouldQuery: false` message is **not** echoed back as a `user` message on the SDK stream. It does cause these frames, per message, in this order (the `uuid` of the appended message is `command_uuid` on the lifecycle frames and the sole `user_message_uuids` entry):
  1. `command_lifecycle` `state: "queued"` (`command_uuid` = the message's uuid)
  2. `command_lifecycle` `state: "started"`
  3. `system` `init`, with `user_message_uuids: [uuid]`
  4. `result` `subtype: "success"`, `num_turns: 0`, `duration_api_ms: 0`, `stop_reason: null`, `user_message_uuids: [uuid]`, no assistant or `stream_event` messages at all
  5. `command_lifecycle` `state: "completed"`

  Two messages appended back to back give two such sequences (the second `queued` arrives while the first is running). **So an empty turn's `result` does arrive between turns**: whatever turns `result` into "Claude finished" (status idle, a result line in the chat) must ignore a `result` whose `num_turns` is 0 and whose `user_message_uuids` are all `shouldQuery: false` appends. The first turn's `result` is the normal one.
- **`MID_TURN`:** appended during a running turn (2 s into `sleep 8`), both entries get `command_lifecycle` `queued` at once, stay queued while the tool runs, and become `started` right after the tool result, together with a `system` `status` frame whose `user_message_uuids` hold the turn's own prompt **and both appended entries**. They are merged into the running turn's next model call (not held for the next user message), and the turn's single `result` lists all three uuids. When asked in the turn's prompt to report any `!` output, the turn's reply quoted the nonce. A follow-up question also got it. So "reaches Claude with the next user message" in the spec is conservative: during a turn, Claude sees it at its next step.
- **`UNIX_SHELL`:** not measured on Linux (no `claude` in WSL; deferred to the hardware check). From Claude Code's tools reference: the Bash tool "starts a non-interactive shell, sources `~/.zshrc` for Zsh or `~/.bashrc` for Bash, and applies the aliases, functions, and shell options it captures", so it uses **the user's zsh or bash** (by `$SHELL`). Recommended for the build: `$SHELL` when its basename is `bash` or `zsh`, else `bash`; run it as `-lic <command>` (a PTY makes an interactive shell natural, and `-l` matches the login-style PATH seen on Windows). Verify on kumbal.
- **`WINDOWS_SHELL`:** Git Bash when Git for Windows is installed, else PowerShell.
  - Git Bash: `CLAUDE_CODE_GIT_BASH_PATH` is honoured and is expected to point at `<Git>\bin\bash.exe`. The CLI then runs `<dir of that file>\..\usr\bin\bash.exe`: pointing the variable at a lone copy of `bash.exe` in a temp folder failed with `'...\tg-bash-copy-xxxx\..\usr\bin\bash.exe' not found`; pointing it at `C:\Program Files\Git\bin\bash.exe` worked. Without the variable it found Git Bash itself (the same one). Inside, `$0` is `/usr/bin/bash`, `$BASH_VERSION` 5.2.37, `$SHELL` `/bin/bash.exe`, and `$PATH` starts `/c/Users/<user>/bin:/mingw64/bin:/usr/local/bin:/usr/bin:/bin` with the profile's duplicates, so it is a login shell. For `!`, find Git Bash the same way as `pty-smoke.mjs`: `CLAUDE_CODE_GIT_BASH_PATH` if the file exists, else `bash.exe` from the folder above `git`'s `cmd\` or `mingw64\bin\`.
  - PowerShell fallback (from code.claude.com's setup and tools pages): "Without Git for Windows, Claude Code runs shell commands via the PowerShell tool." It auto-detects `pwsh.exe` (PowerShell 7+) and falls back to `powershell.exe` (5.1). Not tested against the CLI (Git is installed here, no `pwsh`); `powershell.exe -NoLogo -NoProfile -EncodedCommand <base64 UTF-16LE>` runs correctly in a ConPTY (smoke above). `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` is the CLI's own switch and is not relevant to `!`.

## Findings for the owner

The build follows the CLI in each case unless the owner says otherwise.

1. **The CLI writes two entries, not one** (spec: "one user message … in the same format the CLI writes"). The input entry and the output entry are separate user messages. `normalize.ts` already handles both (`! command`, then a system line). Appending two `shouldQuery: false` messages per command also works as shown in C3. The build writes two entries.
2. **The CLI keeps the start of long output, not the end** (spec: "only its end is kept … following the CLI's limit"). Past 30 000 characters it keeps the first 2 KB inside a `<persisted-output>` wrapper and saves the full output to a file under `~/.claude/projects/...`. The build follows the CLI's *limit* (30 000) and keeps the start, with a cut note in the wrapper's wording but **without** the saved file, because writing under `~/.claude` breaks the hard rule. That makes the note's "Full output saved to" line untrue; the owner may prefer a different line, for example keeping the start and saying "Output too large (N): showing the first 2KB".
3. **Claude Code runs the user's zsh for a zsh user** (spec: "the user's bash on Linux and macOS" and "the one Claude Code's own Bash tool uses"). From the documentation; not measured on Linux here. If it is confirmed on kumbal (the owner's `$SHELL` there is unknown to this spike; the WSL one here is `/usr/bin/zsh`), the build uses `$SHELL` when it is bash or zsh.
4. **Step 6 (owner's `claude --resume`):** open, deferred to the joint test. See below.
5. **The CLI's own `!` started a model turn on this machine.** In both interactive runs (permission mode `default` and the owner's `auto`), an `api-request` and an assistant reply followed each `!` entry pair, and the reply discussed the output. That contradicts the design's "exactly as with the CLI's `!`" only if that is the CLI's normal behaviour; here the user's settings, hooks (a SessionStart hook is active) or the PTY typing could be involved, and this was not isolated. It does not affect the SDK path: C3 showed `shouldQuery: false` starts no turn.
6. **The `result` frame per appended message** (see `ECHOES`) needs handling in `LiveSession` or the entry would flip the chat to "finished" and add a result line.

## Not done

- **Linux real-CLI checks (C1 to C5 on Linux, Step 5 on Linux):** `claude` is not installed in WSL Ubuntu and kumbal is not reachable from here. Deferred to the hardware check on kumbal: `UNIX_SHELL` (what `echo "$0|$BASH_VERSION|$ZSH_VERSION|$SHELL"` and `echo $PATH` print there), and whether the `Shell cwd was reset` note appears on Linux.
- **macOS arm64:** package files read from the tarball only; the run is Task 7's CI.
- **Step 6, open check for the owner:** on kumbal, run `claude --resume <session id>` in a terminal for the chat of C3 and see whether the appended entry displays like a CLI-made `!`. The C3 session was created on **This PC** (Windows) with id `d29b9bd7-b505-4209-a6c4-062fea60bc59` (a throwaway under `%TEMP%`, folder since deleted), so it does not exist on kumbal. To run the check, repeat C3 on kumbal, or do it on This PC: `claude --resume d29b9bd7-b505-4209-a6c4-062fea60bc59` from a folder whose project key matches (`C--Users-USER-AppData-Local-Temp-threadgarden-shell-k9mAZt`). Answer to record: does it show `! echo <nonce>` with the output, or raw tags?
- **The full `shell.real.test.ts` through `pnpm ... test:real -- shell`:** pnpm passed the filter on to vitest in a way that ran every real file here. All the shell tests passed; `service.real.test.ts` "left the Claude config dir untouched" failed because another live Claude session (the one running this task) changed one of its own files during the run (`subagents/agent-….meta.json`), unrelated to this work.

# A Windows PC as a worker (through WSL): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spare Windows 11 PC becomes a Threadgarden worker by running the existing Linux worker in its own WSL distro, set up by one PowerShell script, with shutdown and the power cut adapted to Windows.

**Architecture:**
- **The worker detects that it runs in WSL** and reports `host: 'wsl'` in its machine info, an optional field (no protocol bump).
- **Shutting down:** through `shutdown.exe` instead of `systemctl poweroff`, and never while someone is signed in at the PC (unless Shut down now is confirmed).
- **The 15-minute cut** is left unarmed when Windows has a restart pending.
- **`install.sh`** skips the polkit rule in WSL.
- **A PowerShell script** prepares the Windows side, and its `-Remove` undoes it.

**Tech Stack:** Node 22 service (`execFile` through WSL interop), POSIX `sh`, PowerShell 5.1+, zod, Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-windows-worker-design.md`, resting on the spike `docs/superpowers/specs/2026-11-04-wsl-worker-spike-results.md`.

## Global Constraints

- **No protocol bump in this plan.** `MachineInfoSchema` gains `host: z.enum(['wsl']).optional()` only; part A's plan owns the bump to 11.
- **WSL detection:** `/proc/sys/fs/binfmt_misc/WSLInterop` exists, or `WSL_DISTRO_NAME` is set. Its `platform` stays `linux`.
- **Windows binaries,** by full path through interop: `/mnt/c/Windows/System32/shutdown.exe`, `/mnt/c/Windows/System32/reg.exe`, `/mnt/c/Windows/System32/quser.exe`.
- **Shutdown arguments:**
  - idle: `/s /t 0`;
  - Shut down now confirmed by the owner: `/s /f /t 0`.
- **A restart is pending if any of these exists:**
  - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`;
  - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`;
  - the value `PendingFileRenameOperations` under `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager`.
  - A `reg.exe` that fails counts as "not known", which means not pending.
- **Signed in:** `quser.exe` exit 0 with at least one session line means someone is signed in. Exit 1 ("No User exists") means nobody. Any other failure counts as nobody, logged.
- **Copy:**
  - problem `Someone is signed in on this PC` (exported constant `SIGNED_IN`);
  - confirm title `Someone is signed in on ‹name›. Shut it down anyway?`, confirm button `Shut down`;
  - label `Windows (WSL)`.
- **The cut with a restart pending:** arm as today (`Event tga`), then send `RuleTimer8 0` straight away. The low-reading cut stays armed; the rule text is unchanged.
- **The setup script:**
  - `packaging/windows-wsl/setup-worker.ps1`;
  - default distro name `threadgarden`, firewall rule name `ThreadgardenWorker`, task name `Threadgarden worker`;
  - the boot task runs `wsl.exe -d <distro> --exec sleep infinity` with logon type S4U, RunLevel Limited, no time limit;
  - released as the asset `threadgarden-setup-worker.ps1`, with a `.sha256`.
- **Never change a user's setup silently.** Back up `.wslconfig` (`.wslconfig.bak-threadgarden`). Stop if `networkingMode` is set to something other than `mirrored`. Ask (default no) before `wsl --shutdown`. `-Remove` takes out only what it added.
- **Repo conventions:** `pnpm --config.verify-deps-before-run=false`; no Claude attribution in commits; plain separate git commands.

## Review Focus

1. **A WSL worker on a PC where `quser.exe` or `reg.exe` is missing or hangs** (Windows Home lacks `quser`). Shutdown must still work: bounded by a timeout and treated as "nobody / not pending", never blocking forever. Test: Task 2 `a quser that hangs counts as nobody after its timeout`.
2. **`shutdown.exe` refusing** (no shutdown right for an S4U token). The existing refusal path disarms and shows the reason. Test: Task 2 `a shutdown.exe that fails is reported as a refusal and disarms`.
3. **A non-WSL Ubuntu worker must behave exactly as before:** `systemctl poweroff`, the full cut, no `quser`. Test: Task 2 `outside WSL the sequence is unchanged`.
4. **The script run twice, or `-Remove` run twice:** no duplicate lines, rules or tasks, and no error on a second remove. Test: Task 4 `running setup twice changes nothing the second time` (dry-run assertions).
5. **A `.wslconfig` already holding other `[wsl2]` settings** (the owner's has `memory` and `processors`): they stay, and `networkingMode=mirrored` lands under `[wsl2]`. Test: Task 4 `adds mirrored under an existing [wsl2] and keeps its other lines`.

---

### Task 1: Owner re-check on the main PC (manual, runs alongside the code tasks)

No code. The controller gives the owner these steps on `tg-worker`, which is still set up from the spike. The results go into the spike results document. Task 2's real behaviour depends on them, and the controller rules on any failure before Task 6.

- [ ] **Step 1:** Replace the spike's boot task with the keep-attached one (`--exec sleep infinity`, otherwise the same: S4U, at startup), with "Use my sign-in info to automatically finish setting up after an update" turned off.
- [ ] **Step 2:** In tg-worker, add a one-shot user timer: `systemd-run --user --on-boot=10min /mnt/c/Windows/System32/shutdown.exe /s /t 600 /c "Threadgarden re-check"`. Make it persist across a reboot as a transient-free unit file under `~/.config/systemd/user/` with `OnBootSec=10min`, removed after the check.
- [ ] **Step 3:** Reboot and wait 15 minutes at the lock screen. Log in, and expect a pending shutdown. Run `shutdown /a`, and record the boot, timer and logon times.
- [ ] **Step 4:** Leave the PC up for a few hours with nobody logged in, and repeat the `shutdown.exe` call through `wsl -d tg-worker -- systemd-run --user --wait …` followed by `shutdown /a`.
- [ ] **Step 5:** Run `quser.exe` and `reg.exe query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager" /v PendingFileRenameOperations` from `systemd-run --user --wait` in tg-worker, and record their exit codes and output.

### Task 2: The worker knows it's in WSL, and shuts Windows down properly

**Files:**
- Create: `packages/service/src/power/windows-host.ts`, `packages/service/test/power/windows-host.test.ts`.
- Modify: `packages/protocol/src/machines.ts` (`host`), `packages/protocol/src/power.ts` (`SIGNED_IN`), `packages/service/src/power/shutdown.ts`, `packages/service/src/power/switch.ts` (`armCut({ maxTimer })`), `packages/service/src/main.ts` (`machineOf` adds `host`, `StartOptions.host` seam, passes the Windows host to the sequence), `packages/protocol/test/*`, `packages/service/test/power/shutdown.test.ts`.

**Interfaces:**
- Produces:
  - `detectWsl(deps?: { exists(p): boolean; env: NodeJS.ProcessEnv }): boolean`.
  - `interface WindowsHost { signedIn(): Promise<boolean>; restartPending(): Promise<boolean>; shutdown(opts: { force: boolean }): Promise<void> }`.
  - `windowsHost(deps?: { run: (file, args, {timeoutMs}) => Promise<{code, stdout, stderr}> }): WindowsHost`. Each call is bounded: 15 s for `quser` and `reg`, 30 s for `shutdown`.
  - `ShutdownOptions.windows?: WindowsHost`.
  - `PowerSwitch.armCut(opts?: { maxTimer?: boolean })`: `false` sends `RuleTimer8 0` after `Event tga`.
  - `MachineInfo.host?: 'wsl'`; `SIGNED_IN = 'Someone is signed in on this PC'`.
- Behaviour with `windows` set:
  - The sequence first asks `signedIn()`. If true and the run isn't forced, it settles `{...RUNNING, problem: SIGNED_IN}` without arming.
  - It then asks `restartPending()` and arms with `maxTimer: !pending`.
  - Poweroff is `windows.shutdown({ force: r.force })`. Forced means `/f`.
  - The rest (push check, scheduled-send check, `stopAll`, `watchPoweroff`, refusal handling) is unchanged.

- [ ] **Step 1: Failing tests:**
  - `detectWsl is true with WSLInterop or WSL_DISTRO_NAME, false otherwise`;
  - `signedIn: quser exit 0 with a session line is true, exit 1 is false`;
  - `a quser that hangs counts as nobody after its timeout`;
  - `restartPending: any of the three keys makes it true; reg failing makes it false`;
  - `idle shutdown with someone signed in settles SIGNED_IN and arms nothing`;
  - `forced Shut down now with someone signed in runs shutdown.exe /s /f /t 0`;
  - `a pending restart arms the cut and then sends RuleTimer8 0`;
  - `a shutdown.exe that fails is reported as a refusal and disarms`;
  - `outside WSL the sequence is unchanged` (systemctl poweroff, no RuleTimer8 0, no quser);
  - `hello reports host wsl on a WSL headless machine and omits it elsewhere`;
  - `MachineInfoSchema parses with and without host` (protocol).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/power` and the protocol tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Detection runs once at start; the seam is `StartOptions.host?: 'wsl' | null`. The Windows host is built only when headless and in WSL.
- [ ] **Step 4: Run** the service and protocol suites, typecheck and lint. PASS.
- [ ] **Step 5: Commit** `feat(service): a worker in WSL shuts Windows down, and never under a signed-in person`.

### Task 3: install.sh in WSL skips the polkit rule

**Files:** Modify `packaging/headless/install.sh` and `packages/service/test/packaging/install.test.ts`.

**Interfaces:** Produces: in WSL (the same detection as Task 2, in sh: `[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -n "${WSL_DISTRO_NAME-}" ]`, with the root overridable as `PROC_ROOT=${PROC_ROOT-}` for tests), the polkit section prints `Running in WSL: Windows does the powering off, so no polkit rule is needed.`, asks nothing, and writes no `skipped` marker. Lingering is unchanged.

- [ ] **Step 1: Failing tests:**
  - `in WSL the polkit rule is neither asked for nor marked skipped` (`WSL_DISTRO_NAME=threadgarden`, a failing sudo, a closed rules dir);
  - `in WSL lingering is still asked for`;
  - `outside WSL nothing changes` (the existing polkit tests stay green).
- [ ] **Step 2: Run** `… --filter @threadgarden/service exec vitest run test/packaging/install.test.ts`. On Windows the file is skipped; trace by hand, `sh -n`, and leave the gate to CI's Linux and macOS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `sh -n packaging/headless/install.sh`; service lint.
- [ ] **Step 5: Commit** `feat(headless): install.sh in WSL needs no polkit rule`.

### Task 4: The Windows setup script

**Files:**
- Create: `packaging/windows-wsl/setup-worker.ps1`, `packages/service/test/packaging/setup-worker.test.ts`.
- Modify: `.github/workflows/release.yml` (upload `threadgarden-setup-worker.ps1` and its `.sha256` in the `headless` job), `docs/releasing.md` (the asset list).

**Interfaces:**
- Parameters: `[-Distro threadgarden] [-Remove] [-DryRun] [-Yes]`.
  - `-DryRun` prints every action it would take, one per line prefixed `would:`, and changes nothing.
  - `-Yes` answers the `wsl --shutdown` question with yes, for unattended use.
  - It must run on Windows PowerShell 5.1 (no `??`, `?.` or ternaries).
- Setup, in order:
  1. Require administrator.
  2. Check Windows build ≥ 22621 (22H2).
  3. Check `wsl --version`; if missing, `wsl --install --no-distribution`, then tell the user to reboot and run it again.
  4. Install the distro unless it exists: `wsl --install -d Ubuntu-24.04 --name <distro>`.
  5. `.wslconfig`: back up, then add `networkingMode=mirrored` under `[wsl2]` (creating the section if needed). If a different `networkingMode` is set, stop with a message that names it.
  6. The firewall rule (the Hyper-V VM creator id from the spike), TCP 47380, created only if absent.
  7. The S4U boot task, replaced if it already exists.
  8. Read the active power plan's sleep timeout (`powercfg /query`) and tell the user if it isn't 0.
  9. Offer `wsl --shutdown` (default no).
  10. Print the next commands to run inside the distro: `cd ~`, then the README's Claude Code and Threadgarden steps.
- `-Remove` removes the task, the rule, the line it added (only if it was added by the script: the line carries a `# added by Threadgarden` comment above it), and offers `wsl --unregister <distro>`, asking yes/no with default no.

- [ ] **Step 1: Failing tests,** in Vitest, skipped unless `pwsh` or `powershell.exe` exists. They run the script with `-DryRun` against a temp `USERPROFILE` and stub commands. The script resolves `wsl`, `powercfg` and the cmdlets through script-scope functions that tests override with `$env:THREADGARDEN_SETUP_STUBS` pointing at a stub module.
  - `parses on PowerShell 5.1 and 7` (the parser API);
  - `adds mirrored under an existing [wsl2] and keeps its other lines`;
  - `stops when networkingMode is already something else`;
  - `running setup twice changes nothing the second time`;
  - `-Remove takes out only the added line, the rule and the task`;
  - `-Remove twice reports nothing to remove`;
  - `asks before wsl --shutdown and defaults to no`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/packaging/setup-worker.test.ts`. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again; PASS on this Windows PC and in CI's Windows job.
- [ ] **Step 5: Commit** `feat(packaging): a PowerShell script that readies a Windows PC to be a worker`.

### Task 5: The app says "Windows (WSL)", and asks before shutting down under a person

**Files:** Modify `apps/desktop/src/lib/components/MachinesSettings.svelte` (the version line), `apps/desktop/src/lib/components/layout/MachineHeading.svelte` (the heading's title, and the shut-down flow), `apps/desktop/src/lib/state/power.svelte.ts` if needed, and tests in `apps/desktop/tests/layout/`.

**Interfaces:**
- Consumes Task 2's `MachineInfo.host` and `SIGNED_IN`.
- Produces:
  - the Settings card's version line reads `Threadgarden ‹v› · Windows (WSL)` when `host === 'wsl'`;
  - the heading's tooltip names it too;
  - when `power.shutdown {force:false}` answers with `problem === SIGNED_IN`, the app shows the confirm dialog from Global Constraints, and **Shut down** sends `{force:true}`.

- [ ] **Step 1: Failing tests:**
  - `a WSL machine's card says Windows (WSL)`;
  - `Shut down now on a machine where someone is signed in asks first, then forces`;
  - `an Ubuntu machine's card and shutdown are unchanged`.
- [ ] **Step 2: Run** the desktop tests. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the desktop suite, typecheck and lint. PASS.
- [ ] **Step 5: Commit** `feat(desktop): Windows (WSL) machines, and a confirm before shutting down under someone`.

### Task 6: Docs

**Files:** Modify `README.md` (the connect section gains a short "Or a Windows PC (through WSL)" paragraph: run the released script, then steps 3–6 of the Ubuntu recipe inside the distro; keep it short) and `docs/remote-machines.md` (a `## A Windows PC as the worker (WSL)` section).

The guide section covers:
- requirements;
- the script and what it changes;
- mirrored networking being global;
- `hostAddressLoopback` only for pairing from the same PC;
- automatic restart sign-on;
- sleep;
- active hours for Windows Update;
- power control (BIOS "AC back" as on Ubuntu; the 15-minute cut is skipped while a restart is pending);
- "Someone is signed in";
- removal.

- [ ] **Step 1:** Write them. Check every command against the script and `install.sh`.
- [ ] **Step 2:** `prettier --check` on the README.
- [ ] **Step 3: Commit** `docs: a Windows PC as a worker, through WSL`.

## After the build (owner, on the main PC)

1. Task 1's results are in and green; the controller rules on any failure.
2. In tg-worker, install the branch's headless build with `install.sh`, which is now WSL-aware.
3. Check that Settings shows `Windows (WSL)`.
4. Set idle shutdown to a few minutes and let it shut the PC down; it should be a full power-off. Turn the PC on by hand.
5. While signed in, check that idle doesn't shut down and shows "Someone is signed in". Then use **Shut down now**: the confirm appears, and the PC shuts down.
6. Clean up as in Obsidian, or keep tg-worker as the owner's test worker.

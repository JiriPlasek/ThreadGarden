# A Windows PC as a worker: design

Date: 2026-11-04. This is part B of plan 3; part A is `2026-11-04-away-machine-design.md`.

Status: agreed with the owner in brainstorming. The approach comes from a spike the owner ran on their own PC: `2026-11-04-wsl-worker-spike-results.md`, every check passed. Awaiting their read of this document.

## Why

Today only an Ubuntu PC can be a worker (the "headless" machine that runs chats). The owner wants a Windows PC to work the same way: "same as kumbal, the power control optional, and connect to the PC, so threadgarden could use its claude". It fits their wish that the setup is easy to replicate for others: many people have a spare Windows PC rather than a Linux one.

**Success:**
- Someone with a spare Windows 11 PC runs one setup script and the usual pairing.
- From then on the PC behaves like kumbal: its chats in its own group, power control if they have a plug, idle shutdown, and updates from Settings.

## The approach (decided, from the spike)

**The Windows worker is the existing Linux worker, running in its own WSL distro.**
- That means the same `threadgarden-headless` package, `install.sh`, updater, rollback, protocol and Claude Code (signed in inside the distro).
- There's no native Windows service to build or keep up.

## Goals

1. **Same as an Ubuntu worker** (owner): paired from the app, its chats in its own group, run with that PC's own Claude Code. Projects, Clone, Move to…, usage, part A's copies and waiting messages, and updates from Settings all work as they do there.
2. **Power control optional** (owner): with a Tasmota plug, it can be turned on from the app. Without one, it's on when someone turns it on.
3. **Starts at boot with nobody logged in** (proven in the spike). A plug turning the PC on is a cold boot, so this is the real case.
4. **Idle shutdown and Shut down now turn the whole PC off,** not just WSL, through Windows' `shutdown.exe` (proven in the spike). The hung-shutdown cut on the bridge works as on Ubuntu.
5. **Easy to replicate:** one PowerShell setup script for the Windows side, plus the same few commands inside the distro as on Ubuntu, all in the README's connect section.

## Non-goals

- A native Windows service (no WSL).
- Running the worker on the owner's everyday or gaming PC as the normal setup. It works, as the spike shows, but a spare PC is what this targets.
- Windows 10, or Windows 11 before 22H2: mirrored networking needs 22H2 or newer.
- macOS as a worker.

## Anti-goals

- **Changing someone's existing WSL setup silently.** Their distros, their Docker Desktop, and `.wslconfig` (a global file) are left as they were, except for the lines the script adds. It backs the file up first and says what it changed.
- **Storing the Windows password.** The start-at-boot task uses S4U.
- **A worker that can't be removed cleanly.** The script also removes everything it added.

## What changes

**In the worker, knowing it's in WSL** (detected the standard way, e.g. `/proc/sys/fs/binfmt_misc/WSLInterop` or `WSL_DISTRO_NAME`):
- **Power-off:** idle shutdown and Shut down now run `shutdown.exe /s /t 0` through WSL's interop, by its full Windows path, instead of `systemctl poweroff` (`packages/service/src/power/shutdown.ts`). The rest of the sequence stays the same: the push check, arming the cut, `DID_NOT_POWER_OFF` after 5 minutes.
- **`install.sh` in WSL** skips the polkit rule without asking and without marking it skipped, since it's not needed there. Lingering stays: it's what keeps the worker up.
- **The machine reports itself as a Windows PC through WSL,** so the app can show it fairly. My call: a field in the machine info, such as `host: 'windows-wsl'`. The platform stays `linux`, because paths and git behave as Linux. Settings and the machine heading show "Windows (WSL)". This needs a protocol bump, or an optional field (the builder's call).
- **The update capability** already works in WSL: `systemd-run --user` ran there in the spike.

**A Windows setup script** (new: `packaging/windows-wsl/setup-worker.ps1`, shipped in the release next to the headless package). It's run once in PowerShell as administrator, and it:
1. Checks Windows 11 22H2+ and WSL 2; installs WSL if missing (`wsl --install --no-distribution`), which may need a reboot and a re-run.
2. Creates a dedicated distro, `threadgarden` by default (`wsl --install -d Ubuntu-24.04 --name threadgarden`). The user creates its Linux user when prompted.
3. Backs up `%USERPROFILE%\.wslconfig`, then adds `networkingMode=mirrored` if it isn't there. It says this applies to all their distros and Docker.
4. Adds the Hyper-V firewall rule for TCP 47380.
5. Registers the start-at-boot task, S4U, starting the distro.
6. Tells the user to turn off Windows sleep (the worker can't wake a sleeping PC) and checks the current setting.
7. Prints the commands to run inside the distro next: Claude Code and the Threadgarden package, the same as the README's Ubuntu steps, with `cd ~` first.
8. `-Remove` undoes all of it: it unregisters the distro, removes the rule and the task, and restores `.wslconfig` from its backup.

My call: the script doesn't install Claude Code or Threadgarden inside the distro itself. Signing in to Claude Code is interactive, and the Linux steps stay identical to Ubuntu's, so there's one recipe to maintain.

**Docs:**
- The README's connect section gains "or a Windows PC (through WSL)": the script, then the same steps as Ubuntu.
- `docs/remote-machines.md` gains a Windows section, which covers:
  - mirrored networking being global;
  - `hostAddressLoopback` only for pairing from the same PC;
  - automatic restart sign-on (harmless);
  - the BIOS "AC back" setting for power control, as on Ubuntu;
  - sleep;
  - removal.

## Calls made after the builder check (mine, for the owner to check)

- **Windows updates during shutdown vs the 15-minute cut.** `shutdown.exe` installs waiting updates on the way down, which can take longer than 15 minutes at full power. A cut then could damage Windows.
  - So before an idle shutdown, the worker asks Windows whether a restart is pending: the standard `RebootRequired` / `PendingFileRenameOperations` keys, read with `reg.exe` through interop.
  - If one is pending, the 15-minute cut isn't armed for that shutdown; the cut after the reading drops (about 30 s at low power) stays armed. A hung shutdown then just stays on, as before the cut existed, which is far better than cutting into an update.
  - The setup script doesn't change Windows Update settings (anti-goal). The guide suggests setting active hours, so Windows doesn't restart in the middle of a chat.
- **Keeping the instance attached.** The spike checked shutdown from a logged-in state, and only short uptimes with nobody logged in. Interop from a WSL instance with no `wsl.exe` attached is known to be fragile.
  - So the boot task keeps one attached: `wsl.exe -d <distro> --exec sleep infinity`, under the same S4U task, which shows as running.
  - The plan starts with a short re-check on the owner's PC, before any build task depends on it. A one-shot timer in the distro calls `shutdown.exe /s /t 600` 10 minutes after a boot with nobody logged in. The owner then logs in, sees the pending shutdown and cancels it (`shutdown /a`). The check is repeated after a few hours of uptime.
- **Someone signed in at the Windows PC:**
  - **Idle shutdown** counts a signed-in interactive session as busy, so it never shuts down under a person ("Someone is signed in on ‹machine›").
  - **Shut down now** asks first in the app if someone is signed in, and if confirmed it forces the shutdown (`/f`), so an open app can't block it into the 15-minute cut.
- **Fast Startup isn't a problem:** `shutdown.exe /s` does a full shutdown unless `/hybrid` is given, so the next start is a real boot and the boot task runs. The script changes nothing there.
- **The script and an existing WSL setup:**
  - **A different `networkingMode` already set:** the script stops and explains, and doesn't overwrite it.
  - **Applying the change:** it offers `wsl --shutdown`, warning that it stops all running distros and Docker. The default is no, which means "reboot later".
  - **`-Remove`** takes out only the lines and the rule and task it added. It doesn't restore an old backup over later edits; the backup stays for the user.

## Left to the builder

- The exact WSL detection, and the machine-info field and its protocol handling.
- Error handling and messages in the script, and how it's tested: PowerShell tests where practical, plus a dry-run mode.
- Whether `/mnt/c` can be assumed for `shutdown.exe`, or the path is found through `wslpath` or `cmd.exe`.
- The e2e: the mock can report itself as a WSL worker for the UI label.

## Facts from the spike the builder should know

- WSL 2.4.10, Ubuntu 24.04: systemd on by default; `wslinfo --networking-mode` exists.
- **The instance keeps running after the last window closes,** because systemd and lingering hold it.
- **Logon type S4U works:** the worker was up 2.7 minutes before the first logon.
- **`shutdown.exe` works from `systemd-run --user`** in the distro, exit 0.
- **An interactive `wsl -d <distro>` from an elevated PowerShell starts in `/mnt/c/WINDOWS/system32`.** Commands must not rely on the current folder.

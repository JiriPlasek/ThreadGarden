# A Windows worker through WSL: spike results

Date: 2026-11-04. A hands-on test on the owner's main PC, which checked whether a Windows PC can be a Threadgarden worker by running the existing Linux worker inside WSL.

## The setup

- **The PC:** Windows 11 Pro 25H2 (10.0.26200), WSL 2.4.10. The owner's other distros (`Ubuntu`, `Ubuntu-22.04`, `docker-desktop`) were left alone.
- **A separate distro:** `wsl --install -d Ubuntu-24.04 --name tg-worker`, user `tgworker`. Its `/etc/wsl.conf` already had `[boot] systemd=true`.
- **`%USERPROFILE%\.wslconfig`,** backed up first:
  - `networkingMode=mirrored` under `[wsl2]`;
  - `hostAddressLoopback=true` under `[experimental]` (only so the same PC could pair with it).
- **Firewall:** a Hyper-V firewall rule for TCP 47380 (`New-NetFirewallHyperVRule … -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 47380`).
- **Inside the distro:** Claude Code, signed in, plus the 0.8.0 headless package installed with `install.sh`, exactly as on Ubuntu. Lingering was accepted and the polkit rule skipped.
- **Starting it at boot:** a scheduled task `Threadgarden WSL worker`, which runs `wsl.exe -d tg-worker --exec /bin/true` at startup as the owner, with logon type **S4U** (no stored password) and RunLevel Limited.

## Results

| Check | Result | Evidence |
|---|---|---|
| The worker runs in WSL and listens on the PC's own address | **pass** | `threadgarden status`: protocol 10, headless, "Listening for devices on 100.114.35.57:47380, 192.168.1.103:47380". `wslinfo --networking-mode` says `mirrored`. |
| It pairs, and a chat runs there with the distro's own Claude Code | **pass** | Paired from the owner's Threadgarden; a chat was started and answered. |
| The same PC reaches it at its own LAN address | **needs `hostAddressLoopback=true`** | Without it `Test-NetConnection 192.168.1.103 -Port 47380` failed from the same PC; with it, pairing worked. Another device doesn't need it. |
| It keeps running with every WSL window closed | **pass** | `wsl -l -v` still showed `tg-worker Running` 2 minutes after the last window closed. Systemd and lingering hold the instance up. |
| It starts at boot with **nobody logged in** | **pass** | Boot 17:51:59; task ran 17:52:18 (result 0); `ActiveEnterTimestamp` 17:52:33; the first interactive logon at 17:55:15, per `Win32_LogonSession` and Winlogon event 7001. |
| It can shut the whole PC down | **pass** | `systemd-run --user --wait /mnt/c/Windows/System32/shutdown.exe /s /t 300` exited 0 from the worker's own systemd context, and `shutdown /a` then cancelled it with no error. |

## Findings that shape the design

- **Automatic restart sign-on hides the real test.** "Use my sign-in info to automatically finish setting up after an update" signs the owner in and locks the screen after a restart. The first boot test therefore ran inside a logged-in session: logon at 17:31:58, unlock at 17:35:50.
  - A cold boot after the plug cuts power gets no such sign-in. The real case is "nobody logged in", which passed with the setting off.
- **`.wslconfig` is global:** mirrored networking applies to every distro and to Docker Desktop, and the guide must say so.
- **`systemctl poweroff` inside WSL stops only WSL.** Idle shutdown must call `shutdown.exe` instead, and that works from the worker's context.
- **The polkit rule is not needed in WSL:** the worker never asks Linux to power off.
- **Inside the WSL session, an interactive shell started from PowerShell opens in `/mnt/c/WINDOWS/system32`.** A step that skipped `cd ~` unpacked the download into `C:\Windows\System32`. The guide's and the setup script's commands must not depend on the starting folder.

## Left on the owner's PC until part B is built and tested

`tg-worker`, the firewall rule, the scheduled task, the `.wslconfig` lines (backup `.wslconfig.bak-20261104`) and the paired machine "WSL test". The clean-up steps are in the owner's todo list.

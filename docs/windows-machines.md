# Connect a native Windows machine

This worker runs directly on Windows as your signed-in user. It uses your existing Windows repositories, Claude Code login and history, PATH, Git credentials and development tools. WSL and a second development environment are unnecessary. The [WSL worker](remote-machines.md#a-windows-pc-as-the-worker-wsl) remains available for dedicated PCs.

The native worker supports history, live chats, projects, Clone, Move to and updates from Settings. It has no power control or idle shutdown. It starts when you sign in to Windows, from a startup entry under your user (Task Manager → Startup apps turns it off). It does not register a Windows service or scheduled task or store your Windows password, so after a restart it runs once someone signs in, not before.

## If you already have a WSL worker

The two installations are independent. Native setup does not change your WSL
distro, `.wslconfig`, WSL boot task or Hyper-V firewall rule. It adds its own
Windows installation and firewall rule. Each worker updates its own installation:
the WSL worker uses the Linux release; the native worker uses the Windows zip.

By default, native Threadgarden data is in `%APPDATA%\threadgarden`; WSL data is
in `~/.local/share/threadgarden` inside its distro. Each uses its own environment's
Claude login and history. They have separate machine identities, certificates and
paired devices. Installing native does not migrate or combine WSL chats, settings
or pairings, and the existing WSL pairing cannot connect to the native worker.

Both default to TCP 47380. The WSL setup uses mirrored networking, so treat them
as alternatives on the same PC at the default port. Running both at once would
need separate ports and corresponding firewall configuration; neither installer
sets that up. Also, a running WSL worker's power controls can shut down the whole
Windows PC, including a native worker running on it.

To switch while keeping the WSL installation and its history:

1. Finish any work on the WSL worker. From Windows PowerShell, stop its service
   and disable its automatic startup (replace `threadgarden` if your distro has
   another name):

   ```powershell
   wsl -d threadgarden -- systemctl --user disable --now threadgarden
   ```

   This leaves the distro and its data in place. The existing Windows boot task
   may still start the distro, but its disabled Threadgarden service will not
   start automatically.

2. Install and start the native worker as described below, then run
   `threadgarden pair` in Windows PowerShell and add it as a new machine in
   Settings. Give it a distinct name if the old WSL entry has the same name.
3. Check that the Windows projects and chats you wanted are visible. You can
   keep the old WSL machine entry for later or remove it from Settings.

To switch back, first run `threadgarden stop` in Windows PowerShell, then
`wsl -d threadgarden -- systemctl --user enable --now threadgarden`.

## Prepare the PC

Use a normal, non-administrator PowerShell under the Windows account whose tools and history you want. Make sure Claude Code works there (`claude --version`) and is signed in. Git and any tools your projects need must work in the same Windows account. Clone uses Git; creating GitHub repositories also needs `gh` installed and signed in.

Keep the PC awake while you want it reachable. Connect from the same private network or a VPN such as Tailscale. Pairing uses the existing encrypted connection and one-time code; no router port forwarding is needed.

## Install

Download `threadgarden-headless-windows-x64.zip` and its `.sha256` from the release. In the download folder:

```powershell
$zip = '.\threadgarden-headless-windows-x64.zip'
$expected = (Get-Content "$zip.sha256").Split(' ')[0]
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath $zip -DestinationPath .\threadgarden-download
Get-ChildItem .\threadgarden-download -Filter install.ps1 -Recurse | ForEach-Object {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $_.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
}
```

The installer copies a bundled Node runtime and the service into `%LOCALAPPDATA%\threadgarden-headless`, adds its `bin` folder to your user PATH, sets it to start when you sign in, and starts it. It asks once for administrator approval to add a firewall rule, restricted to TCP 47380, the worker's own executable, private/VPN source addresses, and networks Windows calls Private or Domain. Cancelling that prompt leaves it installed but unreachable from other devices until the rule is added by rerunning the installer.

Windows often calls a network Public when it first joins it, and the rule lets nothing in over a Public one. The installer names any Public network it finds; if that is your home or office network, or your VPN, make it Private in Settings → Network & internet → its connection.

Open a new PowerShell after installation, then:

```powershell
threadgarden status
threadgarden pair
```

If a newly opened terminal has not picked up the PATH change, use `& "$env:LOCALAPPDATA\threadgarden-headless\bin\threadgarden.cmd" pair` or sign out and back in.

On your other PC, open Threadgarden → Settings → Machines → Add machine. Enter an address printed by `pair` (the VPN address when using a VPN) and the code. Existing Windows chats appear under that machine. Choose the machine when starting a new chat and select an existing folder there.

## Start and stop

```powershell
threadgarden start
threadgarden status
threadgarden stop
```

`start` runs in the background without a console window. Closing the terminal or disconnecting Remote Desktop leaves it running. It never exits just because it is idle. Signing out stops it, and it starts again by itself the next time you sign in (a restart included). Started at sign-in it has your user environment as Windows sets it; started from a shell, that shell's. Your chats inherit it, so after changing PATH or other variables run `threadgarden stop` and `threadgarden start`.

To run chats on an API key rather than your Claude subscription, set the user variable `THREADGARDEN_ANTHROPIC_API_KEY` to the key and restart the worker. An `ANTHROPIC_API_KEY` you set for other tools is never used, so it can't bill your chats by accident.

The desktop app on the same PC shares this service and data folder. Close it completely before first starting the worker. Once it uses the worker, its Quit completely also stops the worker. `start` explains if a desktop-mode service is already running rather than silently leaving the PC unreachable.

## Updating

Use Update in Settings → Machines after a release includes the native Windows zip. The machine checks the checksum, installs without an administrator prompt, and restores the previous release if the new one fails to start. An update interrupts running chats, with the same confirmation as other workers.

To update manually, download and verify a newer zip and run its `install.ps1`. The current and previous releases are kept. Installation data and rollback live under `%LOCALAPPDATA%\threadgarden-headless`; update progress and logs are under `%APPDATA%\threadgarden\update` (or `THREADGARDEN_DATA_DIR` when set).

To build the package yourself: `pnpm build:headless --platform windows`; the zip is in `dist-headless`. Releases from the first one with native Windows support carry it.

## Troubleshooting

- Run `threadgarden status`. If it is stopped, run `threadgarden start`.
- Check `%APPDATA%\threadgarden\logs\service.log`, or `logs\service.log` under your custom data directory.
- If there are no listening addresses, connect the network/VPN and wait up to a minute. The worker only listens on private IPv4 addresses.
- If another PC cannot connect, check the `Threadgarden-headless` Windows Firewall rule and the address shown by `threadgarden pair`. Rerunning the installer offers to add a missing rule.
- Missing history or tools usually means a different Windows account or environment. `CLAUDE_CONFIG_DIR`, if set, selects the history location. An existing WSL history stays separate.
- If another PC can't connect although the rule is there, check that Windows calls the network Private, not Public (Settings → Network & internet).
- Chats use your Claude subscription login unless `THREADGARDEN_ANTHROPIC_API_KEY` is set; an `ANTHROPIC_API_KEY` in your environment is ignored.
- If it didn't start at sign-in, check Task Manager → Startup apps for "Threadgarden headless" (rerunning the installer adds it again).
- The worker cannot grant extra drive access. Mapped network drives and credentials must already be available to your signed-in Windows account.

## Remove

Run `threadgarden stop` and remove the machine from Settings on the other PC. Remove its start at sign-in with `Remove-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name 'Threadgarden headless'`. Delete `%LOCALAPPDATA%\threadgarden-headless` and remove its `bin` entry from your user PATH. To remove the firewall rule, run `Remove-NetFirewallRule -Name Threadgarden-headless` in an administrator PowerShell.

Your Threadgarden data stays in `%APPDATA%\threadgarden`; your Claude Code history and repositories stay in their original locations.

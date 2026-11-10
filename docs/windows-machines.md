# Connect a native Windows machine

This worker runs directly on Windows as your signed-in user. It uses your existing Windows repositories, Claude Code login and history, PATH, Git credentials and development tools. WSL and a second development environment are unnecessary. The [WSL worker](remote-machines.md#a-windows-pc-as-the-worker-wsl) remains available for dedicated PCs.

The native worker supports history, live chats, projects, Clone, Move to and updates from Settings. It has no power control or idle shutdown. It does not register a Windows service or scheduled task, store your Windows password, or start at boot.

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

The installer copies a bundled Node runtime and the service into `%LOCALAPPDATA%\threadgarden-headless`, adds its `bin` folder to your user PATH, and starts it. It asks once for administrator approval to add a firewall rule, restricted to TCP 47380, the worker's own executable, and private/VPN source addresses. Cancelling that prompt leaves it installed but unreachable from other devices until the rule is added by rerunning the installer.

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

`start` runs in the background without a console window. Closing the terminal or disconnecting Remote Desktop leaves it running. It never exits just because it is idle. Signing out or restarting Windows stops it; run `threadgarden start` again afterward. Run it from a shell with the PATH and environment you want your chats to inherit. Restart it after changing those variables.

The desktop app on the same PC shares this service and data folder. Close it completely before first starting the worker. Once it uses the worker, its Quit completely also stops the worker. `start` explains if a desktop-mode service is already running rather than silently leaving the PC unreachable.

## Updating

Use Update in Settings → Machines after a release includes the native Windows zip. The machine checks the checksum, installs without an administrator prompt, and restores the previous release if the new one fails to start. An update interrupts running chats, with the same confirmation as other workers.

To update manually, download and verify a newer zip and run its `install.ps1`. The current and previous releases are kept. Installation data and rollback live under `%LOCALAPPDATA%\threadgarden-headless`; update progress and logs are under `%APPDATA%\threadgarden\update` (or `THREADGARDEN_DATA_DIR` when set).

This branch's package is built with `pnpm build:headless --platform windows`; its zip is in `dist-headless`. Official releases will only offer native updates after this support is merged and released.

## Troubleshooting

- Run `threadgarden status`. If it is stopped, run `threadgarden start`.
- Check `%APPDATA%\threadgarden\logs\service.log`, or `logs\service.log` under your custom data directory.
- If there are no listening addresses, connect the network/VPN and wait up to a minute. The worker only listens on private IPv4 addresses.
- If another PC cannot connect, check the `Threadgarden-headless` Windows Firewall rule and the address shown by `threadgarden pair`. Rerunning the installer offers to add a missing rule.
- Missing history or tools usually means a different Windows account or environment. `CLAUDE_CONFIG_DIR`, if set, selects the history location. An existing WSL history stays separate.
- An inherited `ANTHROPIC_API_KEY` is used by headless sessions; unset it before `start` if you intend to use your Claude subscription login.
- The worker cannot grant extra drive access. Mapped network drives and credentials must already be available to your signed-in Windows account.

## Remove

Run `threadgarden stop` and remove the machine from Settings on the other PC. Delete `%LOCALAPPDATA%\threadgarden-headless` and remove its `bin` entry from your user PATH. To remove the firewall rule, run `Remove-NetFirewallRule -Name Threadgarden-headless` in an administrator PowerShell.

Your Threadgarden data stays in `%APPDATA%\threadgarden`; your Claude Code history and repositories stay in their original locations.

# Installs this Threadgarden headless release for the current user on Windows.
# Idempotent: running a newer release's install.ps1 upgrades `current` to it, and
# running the installed copy again just refreshes the launcher, the PATH entry and
# the service. Needs no administrator, except once for the firewall rule (below).
#
# THREADGARDEN_UNATTENDED=1 is the service updating itself: nobody can answer a
# prompt, so it never elevates and never waits for input.
$ErrorActionPreference = 'Stop'

$unattended = $env:THREADGARDEN_UNATTENDED -eq '1'
$pathScope = if ($env:THREADGARDEN_PATH_SCOPE) { $env:THREADGARDEN_PATH_SCOPE } else { 'User' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
# Elevated, the service and every chat it runs would have administrator rights.
if ($admin -and $env:THREADGARDEN_ALLOW_ELEVATED -ne '1') {
  [Console]::Error.WriteLine('Run install.ps1 as your own user, not as administrator.')
  exit 1
}

$src = (Get-Item -LiteralPath $PSScriptRoot).FullName
$versionFile = Join-Path $src 'VERSION'
$version = ''
if (Test-Path -LiteralPath $versionFile) {
  $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
}
if ($version -eq '') {
  [Console]::Error.WriteLine('Empty VERSION.')
  exit 1
}
# It becomes a directory name: letters, digits and . + _ - only, no leading dot.
if ($version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)*$') {
  [Console]::Error.WriteLine("Invalid VERSION '$version'.")
  exit 1
}

$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
$base = [IO.Path]::GetFullPath((Join-Path $localAppData 'threadgarden-headless'))
# All recursive removal stays within a direct child of the install directory.
function Remove-InstallDirectory([string]$target) {
  $resolved = [IO.Path]::GetFullPath($target)
  if ([IO.Path]::GetDirectoryName($resolved) -ne $base) { throw "Outside install directory: $resolved" }
  $item = Get-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to remove a linked release directory: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
$current = Join-Path $base 'current'
$binDir = Join-Path $base 'bin'
$nodeDir = Join-Path $base 'node'
# The firewall rule names this path, so it never changes; each install copies its node.exe here.
$nodeExe = Join-Path $nodeDir 'node.exe'
$cli = if ($env:THREADGARDEN_CLI) { $env:THREADGARDEN_CLI } else { Join-Path $binDir 'threadgarden.cmd' }

Write-Output "Installing Threadgarden headless $version"
New-Item -ItemType Directory -Force -Path $base, $binDir, $nodeDir | Out-Null

# The version `current` points at now, kept as the rollback target.
$previous = ''
$link = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
if ($link -and $link.LinkType -eq 'Junction') {
  $previous = Split-Path -Leaf (@($link.Target)[0].TrimEnd('\'))
}
if ($link -and $link.LinkType -ne 'Junction') { throw 'current must be a directory junction.' }

# Stop through the OLD service and launcher before replacing any release files.
# This also releases the stable executable on a same-version reinstall.
if (Test-Path -LiteralPath $nodeExe) {
  Write-Output 'Running: threadgarden stop'
  & $cli stop
  if ($LASTEXITCODE -ne 0) { throw 'Threadgarden did not stop; installation cancelled.' }
}

$dest = Join-Path $base $version
$destFull = ''
if (Test-Path -LiteralPath $dest) { $destFull = (Get-Item -LiteralPath $dest).FullName }
if ($destFull -ne $src) {
  # Copy aside, then swap in, so a failed copy never leaves a half release.
  $tmp = Join-Path $base ".$version.tmp.$PID"
  if (Test-Path -LiteralPath $tmp) { Remove-InstallDirectory $tmp }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Get-ChildItem -LiteralPath $src -Force | Copy-Item -Destination $tmp -Recurse -Force
  } catch {
    try { Remove-InstallDirectory $tmp } catch {}
    throw
  }
  if (Test-Path -LiteralPath $dest) { Remove-InstallDirectory $dest }
  Rename-Item -LiteralPath $tmp -NewName $version
}

# A junction needs no administrator, unlike a symbolic link. Deleting it never
# touches the folder it points at.
if ($link) { [System.IO.Directory]::Delete($current) }
New-Item -ItemType Junction -Path $current -Target $dest | Out-Null

# Copies an earlier run left half-done.
Get-ChildItem -LiteralPath $base -Directory -Force -Filter '.*.tmp.*' | ForEach-Object {
  try { Remove-InstallDirectory $_.FullName } catch {}
}
# Keep this release and the one before it; drop the rest. Reinstalling the
# current version (previous == version) must not cost the rollback, so it prunes nothing.
if ($previous -ne $version) {
  $keep = @($version, $previous, 'bin', 'node', 'current')
  $old = Get-ChildItem -LiteralPath $base -Directory -Force | Where-Object {
    -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
    $_.Name -cmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)*$' -and
    $keep -notcontains $_.Name
  }
  foreach ($dir in $old) {
    try {
      Remove-InstallDirectory $dir.FullName
    } catch {
      Write-Output "Could not remove $($dir.Name), probably still in use; it is left in place."
    }
  }
}

Copy-Item -LiteralPath (Join-Path $dest 'bin\threadgarden.cmd') -Destination (Join-Path $binDir 'threadgarden.cmd') -Force

# The user's PATH, kept as the registry has it (%VAR% entries stay unexpanded).
$entries = @()
if ($pathScope -eq 'User') {
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $raw = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
} else {
  $raw = [Environment]::GetEnvironmentVariable('Path', $pathScope)
}
if ($raw) { $entries = @($raw -split ';' | Where-Object { $_ -ne '' }) }
$onPath = $entries | Where-Object { $_.TrimEnd('\') -eq $binDir.TrimEnd('\') }
if (-not $onPath) {
  $newPath = (@($entries) + $binDir) -join ';'
  if ($pathScope -eq 'User') {
    $kind = if ($raw) { $envKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $envKey.SetValue('Path', $newPath, $kind)
    # Clearing a variable that isn't there tells running programs the environment changed,
    # so a terminal started from now on sees the new PATH.
    [Environment]::SetEnvironmentVariable('THREADGARDEN_PATH_REFRESH', $null, 'User')
  } else {
    [Environment]::SetEnvironmentVariable('Path', $newPath, $pathScope)
  }
  Write-Output "Added $binDir to your PATH (terminals opened from now on find threadgarden)."
}
if ($envKey) { $envKey.Close() }

# Windows Firewall lets nothing in to node.exe until a rule allows it. One rule,
# for Threadgarden's own node.exe on its port from private addresses only, made
# once as administrator; updates keep node.exe at the same path, so they never need it again.
if (-not $unattended) {
  $hasRule = $false
  try {
    $hasRule = [bool](Get-NetFirewallRule -Name 'Threadgarden-headless' -ErrorAction Stop)
  } catch {
    $hasRule = $false
  }
  if ($hasRule) {
    Write-Output 'The firewall rule that lets paired devices reach Threadgarden is already in place.'
  } else {
    $program = $nodeExe.Replace("'", "''")
    $rule = "New-NetFirewallRule -Name 'Threadgarden-headless' -DisplayName 'Threadgarden headless' " +
      '-Direction Inbound -Action Allow -Protocol TCP -LocalPort 47380 ' +
      "-Program '$program' " +
      '-RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10 -Profile Any'
    $script = "try { $rule | Out-Null; exit 0 } catch { exit 1 }"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Write-Output ''
    Write-Output 'Paired devices reach Threadgarden on port 47380. Windows Firewall needs a rule'
    Write-Output 'for that, which takes administrator rights once. Windows will ask now; say No'
    Write-Output 'to skip it, and other devices will not reach this machine.'
    $code = 1
    try {
      if ($env:THREADGARDEN_ELEVATE) {
        & $env:THREADGARDEN_ELEVATE -NoProfile -NonInteractive -EncodedCommand $encoded
        $code = $LASTEXITCODE
      } else {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
          -ArgumentList "-NoProfile -NonInteractive -EncodedCommand $encoded"
        $code = $p.ExitCode
      }
    } catch {
      $code = 1
    }
    if ($code -eq 0) {
      Write-Output 'Added the firewall rule.'
    } else {
      Write-Output "Skipped the firewall rule; other devices can't reach this machine until install.ps1 is run again and the rule is allowed."
    }
  }
}

# Starts it, or restarts it so an upgrade takes effect. node.exe can only be
# replaced while no service runs it.
Write-Output ''
Copy-Item -LiteralPath (Join-Path $current 'bin\node.exe') -Destination $nodeExe -Force
Write-Output 'Running: threadgarden start'
& $cli start
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine('Threadgarden did not start; see %APPDATA%\threadgarden\logs\service.log.')
  exit 1
}

if (-not $unattended) {
  Write-Output ''
  Write-Output 'Installed. Pair this machine with your desktop: threadgarden pair'
  Write-Output 'After a restart of this PC, start Threadgarden again with: threadgarden start'
}
exit 0

<#
.SYNOPSIS
Readies this Windows PC to be a Threadgarden worker: the worker runs in its own
WSL distro, reached on the PC's own address.

.DESCRIPTION
Run once in PowerShell as administrator, from the session of the Windows user who
will own the worker. It installs WSL and an Ubuntu distro for the worker, turns on
mirrored networking in your .wslconfig (backed up first), lets port 47380 through
the Hyper-V firewall, and starts the distro at boot with nobody signed in. Inside
the distro you then install Claude Code and Threadgarden as on Ubuntu; the script
prints those commands at the end.

It never changes your setup silently: a different networkingMode stops it, it asks
before wsl --shutdown, and -Remove takes out only what it added.

.PARAMETER Distro
The worker's WSL distro (default threadgarden).

.PARAMETER Remove
Undoes the setup: the scheduled task, the firewall rule and the .wslconfig lines it
added, then offers to unregister the distro (default no).

.PARAMETER DryRun
Prints every change it would make, one per line starting with "would:", and
changes nothing.

.PARAMETER Yes
Answers yes to running wsl --shutdown, for unattended use.
#>
[CmdletBinding()]
param(
  [string]$Distro = 'threadgarden',
  [switch]$Remove,
  [switch]$DryRun,
  [switch]$Yes,
  # Tests only: a file that replaces the functions touching Windows. A parameter, not
  # an environment variable, so nothing inherited can slip code into an elevated run.
  [Parameter(DontShow)][string]$StubsPath
)

# Windows PowerShell 5.1 runs this too: no ??, ?. or ternaries, and ASCII only.
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$RuleName = 'ThreadgardenWorker'
$TaskName = 'Threadgarden worker'
$Port = 47380
# The Hyper-V firewall's id for WSL's virtual machine.
$VmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$MinBuild = 22621
$Marker = '# added by Threadgarden'
$OurLine = 'networkingMode=mirrored'

# --- What touches Windows. Tests replace these through -StubsPath. ---

function Test-TgAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal -ArgumentList $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TgBuild { [Environment]::OSVersion.Version.Build }

# Whom this elevated run belongs to: WSL distros, the task and .wslconfig are per user.
function Get-TgUser { [Security.Principal.WindowsIdentity]::GetCurrent().Name }

# Who is signed in at the console ($null over Remote Desktop, or when nobody is).
function Get-TgSignedInUser { (Get-CimInstance -ClassName Win32_ComputerSystem).UserName }

# The elevated user's own folder, whatever the environment's USERPROFILE says.
function Get-TgProfile { [Environment]::GetFolderPath('UserProfile') }

# A native program's stderr would be a terminating error under 'Stop' in 5.1.
function Test-TgWsl {
  $ErrorActionPreference = 'Continue'
  try {
    & wsl.exe --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

# In the same console, so the distro's first start can ask for the Linux user.
function Invoke-TgWsl {
  param([string[]]$Arguments)
  $p = Start-Process -FilePath 'wsl.exe' -ArgumentList $Arguments -NoNewWindow -Wait -PassThru
  $p.ExitCode
}

# The current user's distros, from the registry: wsl.exe's own list is UTF-16.
function Get-TgDistros {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path -LiteralPath $key)) { return @() }
  @(Get-ChildItem -LiteralPath $key | ForEach-Object { $_.GetValue('DistributionName') })
}

function Test-TgFirewallRule {
  param([string]$Name)
  $null -ne (Get-NetFirewallHyperVRule -Name $Name -ErrorAction SilentlyContinue)
}

function New-TgFirewallRule {
  param([string]$Name, [string]$VmCreatorId, [int]$Port)
  New-NetFirewallHyperVRule -Name $Name -DisplayName 'Threadgarden worker' -Direction Inbound `
    -VMCreatorId $VmCreatorId -Protocol TCP -LocalPorts $Port -Action Allow | Out-Null
}

function Remove-TgFirewallRule {
  param([string]$Name)
  Remove-NetFirewallHyperVRule -Name $Name
}

function Test-TgTask {
  param([string]$Name)
  $null -ne (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}

# At startup, as this user without a stored password (S4U), not elevated, never stopped.
function Register-TgTask {
  param([string]$Name, [string]$Execute, [string]$Argument, [string]$User)
  $action = New-ScheduledTaskAction -Execute $Execute -Argument $Argument
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Keeps the Threadgarden worker in WSL running from boot.' `
    -Force | Out-Null
}

function Unregister-TgTask {
  param([string]$Name)
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
}

function Get-TgSleepQuery {
  $ErrorActionPreference = 'Continue'
  & powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2> $null
}

# With no console to ask (-NonInteractive), the answer is the default: no.
function Read-TgAnswer {
  param([string]$Prompt)
  try {
    Read-Host $Prompt
  } catch {
    ''
  }
}

if ($StubsPath) { . $StubsPath }

$ProfileDir = Get-TgProfile
$ConfigPath = Join-Path $ProfileDir '.wslconfig'
$BackupPath = Join-Path $ProfileDir '.wslconfig.bak-threadgarden'

# --- Helpers ---

function Say([string]$Message) { Write-Host $Message }

function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# Runs a change, or with -DryRun only says what it would be.
function Invoke-TgChange([string]$What, [scriptblock]$Do) {
  if ($DryRun) { Write-Host "would: $What" } else { & $Do }
}

function Confirm-Tg([string]$Prompt) {
  $answer = Read-TgAnswer "$Prompt [y/N]"
  ($null -ne $answer) -and ([string]$answer).Trim() -match '^(y|yes)$'
}

# The file's lines, its line ending and its encoding (kept as they were, BOM or not).
function Read-TgConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  $noBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  $reader = New-Object System.IO.StreamReader -ArgumentList $ConfigPath, $noBom, $true
  try {
    $text = $reader.ReadToEnd()
    $encoding = $reader.CurrentEncoding
  } finally {
    $reader.Dispose()
  }
  $newline = "`r`n"
  if (-not $text.Contains("`r`n") -and $text.Contains("`n")) { $newline = "`n" }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($text -split '\r?\n')) { $lines.Add($line) }
  @{ Lines = $lines; Newline = $newline; Encoding = $encoding }
}

function Write-TgConfig($Config) {
  $text = [string]::Join($Config.Newline, $Config.Lines.ToArray())
  [System.IO.File]::WriteAllText($ConfigPath, $text, $Config.Encoding)
}

# A section header's name ("wsl2" for "[wsl2]  # a comment"), or $null for any other line.
function Get-TgSection([string]$Line) {
  if ($Line.Trim() -match '^\[([^\]]*)\]\s*([#;].*)?$') { return $Matches[1].Trim() }
  $null
}

# The first [wsl2] header's index (-1: none), and networkingMode's value there ($null: unset).
function Find-TgMode($Lines) {
  $inWsl2 = $false
  $header = -1
  $value = $null
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $section = Get-TgSection $Lines[$i]
    if ($null -ne $section) {
      $inWsl2 = $section -ieq 'wsl2'
      if ($inWsl2 -and $header -lt 0) { $header = $i }
      continue
    }
    $t = $Lines[$i].Trim()
    if (-not $inWsl2 -or $t -match '^[#;]') { continue }
    if ($t -match '^networkingMode\s*=\s*(.*)$') {
      $value = ($Matches[1] -replace '\s+[#;].*$', '').Trim().Trim('"')
    }
  }
  @{ Header = $header; Value = $value }
}

# Our marker's index when the line under it is still ours (-1: none).
function Find-TgOurLine($Lines) {
  for ($i = 0; $i -lt $Lines.Count - 1; $i++) {
    if ($Lines[$i].Trim() -eq $Marker -and $Lines[$i + 1].Trim() -ieq $OurLine) { return $i }
  }
  -1
}

# Whether a marker sits above a line that is neither ours nor a section header.
function Test-TgChangedLine($Lines) {
  for ($i = 0; $i -lt $Lines.Count - 1; $i++) {
    if ($Lines[$i].Trim() -ne $Marker) { continue }
    if ($null -eq (Get-TgSection $Lines[$i + 1]) -and $Lines[$i + 1].Trim() -ine $OurLine) { return $true }
  }
  $false
}

# Takes out a [wsl2] header this script added, once its section holds nothing else,
# with the blank line it put before it at the end of the file.
function Remove-TgOurSection($Lines) {
  for ($i = 0; $i -lt $Lines.Count - 1; $i++) {
    if ($Lines[$i].Trim() -ne $Marker -or (Get-TgSection $Lines[$i + 1]) -ine 'wsl2') { continue }
    $end = $i + 2
    while ($end -lt $Lines.Count -and $null -eq (Get-TgSection $Lines[$end])) {
      if ($Lines[$end].Trim() -ne '') { return }
      $end++
    }
    $last = $end -eq $Lines.Count
    $Lines.RemoveRange($i, $end - $i)
    if ($last) {
      while ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1].Trim() -eq '') {
        $Lines.RemoveAt($Lines.Count - 1)
      }
      if ($Lines.Count -gt 0) { $Lines.Add('') }
    }
    return
  }
}

# --- Start ---

if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  Fail "The distro name '$Distro' can only have letters, digits, dots, dashes and underscores."
}
# 1. Administrator: the firewall rule and the boot task need it.
if (-not (Test-TgAdmin)) {
  if ($DryRun) {
    Say 'Not running as administrator; a real run needs PowerShell as administrator.'
  } else {
    Fail 'Run this in PowerShell as administrator (right-click PowerShell, Run as administrator).'
  }
}
# Elevated as another account (a UAC prompt answered with an admin's password), this
# would set up that account's WSL, .wslconfig and task: not the one signed in here.
$user = Get-TgUser
$signedIn = Get-TgSignedInUser
if ($signedIn -and $signedIn -ine $user) {
  Fail ("This runs as $user, but $signedIn is signed in on this PC. The worker belongs " +
    'to the Windows user who sets it up: sign in as that user, open PowerShell there with ' +
    'Run as administrator, and run this again.')
}
if (-not $signedIn) {
  Say "This runs as $user. (Who is signed in at the console couldn't be told, so make sure"
  Say 'that is the Windows user who will own the worker.)'
}

if ($Remove) {
  $found = $false

  if (Test-TgTask -Name $TaskName) {
    $found = $true
    Invoke-TgChange "remove the scheduled task '$TaskName'" {
      Unregister-TgTask -Name $TaskName
      Say "Removed the scheduled task '$TaskName'."
    }
  } else {
    Say "No scheduled task '$TaskName' to remove."
  }

  if (Test-TgFirewallRule -Name $RuleName) {
    $found = $true
    Invoke-TgChange "remove the firewall rule '$RuleName'" {
      Remove-TgFirewallRule -Name $RuleName
      Say "Removed the firewall rule '$RuleName'."
    }
  } else {
    Say "No firewall rule '$RuleName' to remove."
  }

  $config = Read-TgConfig
  $at = -1
  if ($null -ne $config) { $at = Find-TgOurLine $config.Lines }
  if ($at -ge 0) {
    $found = $true
    Invoke-TgChange "remove $OurLine (added by Threadgarden) from $ConfigPath" {
      $config.Lines.RemoveRange($at, 2)
      Remove-TgOurSection $config.Lines
      Write-TgConfig $config
      Say "Removed $OurLine from $ConfigPath. Your other settings there are unchanged."
    }
  } elseif ($null -ne $config -and (Test-TgChangedLine $config.Lines)) {
    Say "The line under '$Marker' in $ConfigPath was changed since, so it stays as it is."
  } else {
    Say "No line added by Threadgarden in $ConfigPath."
  }
  if (Test-Path -LiteralPath $BackupPath) {
    Say "The backup $BackupPath stays, for you to delete when you like."
  }

  if (@(Get-TgDistros) -contains $Distro) {
    $found = $true
    if ($DryRun) {
      Say "would: ask whether to unregister the WSL distro '$Distro' (default no)"
    } elseif (Confirm-Tg "Unregister the WSL distro '$Distro'? This deletes everything in it for good.") {
      $code = Invoke-TgWsl @('--unregister', $Distro)
      if ($code -ne 0) { Fail "wsl --unregister $Distro failed (exit code $code)." }
      Say "Unregistered the WSL distro '$Distro'."
    } else {
      Say "Kept the WSL distro '$Distro'. To delete it later: wsl --unregister $Distro"
    }
  } else {
    Say "No WSL distro '$Distro' to unregister."
  }

  if (-not $found) { Say 'Nothing to remove.' }
  exit 0
}

# 2. Windows 11 22H2 or newer: mirrored networking needs it.
$build = Get-TgBuild
if ($build -lt $MinBuild) {
  Fail "This needs Windows 11 22H2 (build $MinBuild) or newer; this PC is build $build."
}

# A networkingMode of the user's own stops everything, so it is read before anything
# is installed.
$config = Read-TgConfig
$mode = @{ Header = -1; Value = $null }
if ($null -ne $config) { $mode = Find-TgMode $config.Lines }
if ($null -ne $mode.Value -and $mode.Value -ine 'mirrored') {
  Fail ("Your $ConfigPath sets networkingMode=$($mode.Value) under [wsl2]. The worker needs " +
    "networkingMode=mirrored, and this script won't overwrite your setting. Change it " +
    'yourself if you can (it applies to all your distros and Docker Desktop), then run this again.')
}

# 3. WSL itself. A fresh install needs a restart before a distro can be added.
if (-not (Test-TgWsl)) {
  if (-not $DryRun) { Say 'WSL is not installed yet. Installing it (this can take a few minutes).' }
  Invoke-TgChange 'wsl --install --no-distribution' {
    $code = Invoke-TgWsl @('--install', '--no-distribution')
    if ($code -ne 0) { Fail "wsl --install --no-distribution failed (exit code $code)." }
    Say 'Restart Windows, then run this script again. If it still says WSL is not'
    Say 'installed after the restart, run wsl --update first.'
  }
  exit 0
}

# 4. The worker's own distro, so the user's other distros stay as they are.
if (@(Get-TgDistros) -contains $Distro) {
  Say "The WSL distro '$Distro' is already there."
} else {
  if (-not $DryRun) {
    Say "Installing Ubuntu 24.04 as the WSL distro '$Distro'. When it asks, create your"
    Say 'Linux user; then type exit to come back here.'
  }
  Invoke-TgChange "wsl --install -d Ubuntu-24.04 --name $Distro" {
    $code = Invoke-TgWsl @('--install', '-d', 'Ubuntu-24.04', '--name', $Distro)
    if ($code -ne 0) { Fail "wsl --install -d Ubuntu-24.04 --name $Distro failed (exit code $code)." }
  }
}

# 5. Mirrored networking: the worker listens on the PC's own address.
if ($mode.Value -ieq 'mirrored') {
  Say "Mirrored networking is already on in $ConfigPath."
} else {
  Say 'Mirrored networking applies to all your WSL distros and to Docker Desktop, not only the worker.'
  if ($null -ne $config) {
    if (Test-Path -LiteralPath $BackupPath) {
      Say "Keeping the earlier backup $BackupPath."
    } else {
      Invoke-TgChange "back up $ConfigPath to $BackupPath" {
        Copy-Item -LiteralPath $ConfigPath -Destination $BackupPath
        Say "Backed up $ConfigPath to $BackupPath."
      }
    }
  }
  Invoke-TgChange "add $OurLine under [wsl2] in $ConfigPath" {
    # A [wsl2] header made here is marked too, so -Remove can take it out again.
    $section = @($Marker, '[wsl2]', $Marker, $OurLine)
    if ($null -eq $config) {
      $lines = New-Object System.Collections.Generic.List[string]
      foreach ($line in ($section + '')) { $lines.Add($line) }
      $config = @{ Lines = $lines; Newline = "`r`n"; Encoding = (New-Object System.Text.UTF8Encoding -ArgumentList $false) }
    } elseif ($mode.Header -ge 0) {
      $config.Lines.InsertRange($mode.Header + 1, [string[]]@($Marker, $OurLine))
    } else {
      # At the end, after a blank line, before the final line ending.
      $end = $config.Lines.Count
      if ($end -gt 0 -and $config.Lines[$end - 1] -eq '') { $end-- }
      if ($end -gt 0 -and $config.Lines[$end - 1].Trim() -ne '') { $section = @('') + $section }
      $config.Lines.InsertRange($end, [string[]]$section)
      if ($config.Lines[$config.Lines.Count - 1] -ne '') { $config.Lines.Add('') }
    }
    Write-TgConfig $config
    Say "Added $OurLine under [wsl2] in $ConfigPath."
  }
}

# 6. Let paired devices reach the worker's port through the Hyper-V firewall.
if (Test-TgFirewallRule -Name $RuleName) {
  Say "The firewall rule '$RuleName' is already there."
} else {
  Invoke-TgChange "add the Hyper-V firewall rule '$RuleName' for TCP $Port" {
    New-TgFirewallRule -Name $RuleName -VmCreatorId $VmCreatorId -Port $Port
    Say "Added the Hyper-V firewall rule '$RuleName' for TCP $Port."
  }
}

# 7. Start the distro at boot, with nobody signed in. Its systemd and lingering then
#    start the worker; the task keeps one wsl.exe attached so interop stays up.
$verb = 'add'
if (Test-TgTask -Name $TaskName) { $verb = 'replace' }
Invoke-TgChange "$verb the scheduled task '$TaskName' (at startup, as $user): wsl.exe -d $Distro --exec sleep infinity" {
  Register-TgTask -Name $TaskName -Execute 'wsl.exe' -Argument "-d $Distro --exec sleep infinity" -User $user
  Say "The scheduled task '$TaskName' starts the worker at boot, as $user."
}

# 8. A sleeping PC can't be woken by the worker or the power switch.
$values = @(Get-TgSleepQuery | ForEach-Object { [regex]::Matches([string]$_, '0x[0-9a-fA-F]+') } |
    ForEach-Object { $_.Value })
if ($values.Count -lt 2) {
  Say 'Could not read the sleep setting. Make sure Windows never sleeps on mains power.'
} else {
  # The query ends with the AC (mains) value, then the DC (battery) one, in seconds.
  $seconds = [Convert]::ToInt64($values[$values.Count - 2], 16)
  if ($seconds -eq 0) {
    Say 'Sleep is off on mains power. Good: a sleeping PC would be out of reach.'
  } else {
    Say "Windows puts this PC to sleep after $([math]::Round($seconds / 60)) minutes on mains power,"
    Say 'and then nothing can reach the worker. To turn sleep off, run:'
    Say '  powercfg /change standby-timeout-ac 0'
  }
}

# 9. Mirrored networking applies once WSL restarts.
if ($DryRun) {
  if ($Yes) { Say 'would: wsl --shutdown' } else { Say 'would: ask whether to run wsl --shutdown (default no)' }
} else {
  Say 'WSL uses mirrored networking once it restarts. wsl --shutdown restarts it now,'
  Say 'but it stops every running distro, and Docker Desktop with them.'
  if ($Yes -or (Confirm-Tg 'Run wsl --shutdown now?')) {
    $code = Invoke-TgWsl @('--shutdown')
    if ($code -ne 0) { Fail "wsl --shutdown failed (exit code $code)." }
    Say 'WSL restarted.'
  } else {
    Say 'Left WSL running: the change applies after the next restart of Windows.'
  }
}

# 10. The rest happens inside the distro, as on Ubuntu (see the README).
Say ''
Say "Next, open the distro with: wsl -d $Distro"
Say 'Then, inside it, Claude Code (it prints a sign-in link to open on any computer):'
Say '  cd ~'
Say '  curl -fsSL https://claude.ai/install.sh | bash'
Say '  source ~/.profile'
Say '  claude'
Say 'Then Threadgarden:'
Say '  rm -rf ~/threadgarden-download && mkdir ~/threadgarden-download && cd ~/threadgarden-download'
Say '  base=https://github.com/JiriPlasek/ThreadGarden/releases/latest/download'
Say '  curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz"'
Say '  curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz.sha256"'
Say '  sha256sum -c threadgarden-headless-linux-x64.tar.gz.sha256'
Say '  tar -xzf threadgarden-headless-linux-x64.tar.gz'
Say '  cd threadgarden-headless-*/'
Say '  ./install.sh'
Say '  threadgarden status'
Say 'For Clone and new repos, also set up git and GitHub as in the README (step 4).'
Say 'Then run threadgarden pair, and add the machine in Threadgarden: Settings, Machines.'
exit 0

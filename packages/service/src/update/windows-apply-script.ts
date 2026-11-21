/** Runs outside the service: installing replaces the Node process which launched it. */
export const WINDOWS_APPLY_SCRIPT = String.raw`param(
  [string]$installSh, [string]$version, [string]$from,
  [string]$installBase, [string]$updateDir, [int]$timeoutS = 90
)
$ErrorActionPreference = 'Stop'
$last = Join-Path $updateDir 'last.json'
$cli = Join-Path $installBase 'bin\threadgarden.cmd'
$current = Join-Path $installBase 'current'
$env:THREADGARDEN_UNATTENDED = '1'

function Rollback([string]$reason) {
  # Stop first, so a late new service cannot overwrite the failure or hold node.exe.
  try { & $cli stop *> (Join-Path $updateDir 'rollback.log') } catch {}
  try {
    $old = Join-Path $installBase $from
    if (Test-Path -LiteralPath (Join-Path $old 'bin\node.exe')) {
      $link = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
      if ($link -and $link.LinkType -ne 'Junction') { throw 'current is not a junction' }
      if ($link) { [IO.Directory]::Delete($current) }
      New-Item -ItemType Junction -Path $current -Target $old | Out-Null
      Copy-Item -LiteralPath (Join-Path $old 'bin\node.exe') -Destination (Join-Path $installBase 'node\node.exe') -Force
      Copy-Item -LiteralPath (Join-Path $old 'bin\threadgarden.cmd') -Destination $cli -Force
    }
  } catch { $_ | Out-String | Add-Content -LiteralPath (Join-Path $updateDir 'rollback.log') }
  $tmp = "$last.$PID.tmp"
  @{ state = 'failed'; version = $version; from = $from; reason = $reason } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
  # Node reads UTF-8 JSON without a BOM.
  [IO.File]::WriteAllText($tmp, ([IO.File]::ReadAllText($tmp)), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $last -Force
  Remove-Item -LiteralPath (Join-Path $updateDir 'pending.json') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $updateDir 'apply.pid') -Force -ErrorAction SilentlyContinue
  try { & $cli start *>> (Join-Path $updateDir 'rollback.log') } catch {}
  exit 1
}

Remove-Item -LiteralPath $last -Force -ErrorAction SilentlyContinue
try {
  # Wait for the installer process only. PowerShell's native invocation (and
  # Start-Process -Wait) can wait for its background service descendants too.
  $launch = @{
    FilePath = "$PSHOME\powershell.exe"; WindowStyle = 'Hidden'; PassThru = $true
    ArgumentList = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $installSh + '"'
    RedirectStandardOutput = Join-Path $updateDir 'install.log'
    RedirectStandardError = Join-Path $updateDir 'install-error.log'
  }
  $installer = Start-Process @launch
  # Cache the native handle before it exits, so Windows PowerShell retains ExitCode.
  $null = $installer.Handle
  # The parameterless overload also drains redirected streams, which descendants
  # may still hold. The timed overload waits only for this process to exit.
  if (-not $installer.WaitForExit(300000)) {
    try { $installer.Kill() } catch {}
    Rollback 'install'
  }
  if ($installer.ExitCode -ne 0) { Rollback 'install' }
} catch { Rollback 'install' }
for ($waited = 0; $waited -lt $timeoutS; $waited++) {
  try {
    $status = Get-Content -LiteralPath $last -Raw | ConvertFrom-Json
    if ($status.state -eq 'done' -and $status.version -eq $version) { exit 0 }
  } catch {}
  Start-Sleep -Seconds 1
}
Rollback 'start'
`;

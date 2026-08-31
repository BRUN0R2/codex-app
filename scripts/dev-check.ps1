[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$defaultPort = 1420
$requestedPort = $defaultPort
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$debugExecutablePath = Join-Path $projectRoot "src-tauri\target\debug\codex-desktop-next.exe"
. (Join-Path $PSScriptRoot "runtime-profile.ps1")
. (Join-Path $PSScriptRoot "project-tools.ps1")
Enable-ProjectTools -ProjectRoot $projectRoot | Out-Null

if ($env:CODEX_DESKTOP_DEV_PORT) {
  $portFromEnv = 0
  if (-not [int]::TryParse($env:CODEX_DESKTOP_DEV_PORT, [ref]$portFromEnv)) {
    throw "CODEX_DESKTOP_DEV_PORT must be an integer between 1 and 65535."
  }
  $requestedPort = $portFromEnv
} elseif ($env:VITE_PORT) {
  $portFromViteEnv = 0
  if (-not [int]::TryParse($env:VITE_PORT, [ref]$portFromViteEnv)) {
    throw "VITE_PORT must be an integer between 1 and 65535."
  }
  $requestedPort = $portFromViteEnv
}

if ($requestedPort -lt 1 -or $requestedPort -gt 65535) {
  throw "Invalid development port: $requestedPort. Use a value between 1 and 65535."
}

$existingDevProcesses = @(Get-ProcessesByExecutablePath -ExecutablePath $debugExecutablePath)
if ($existingDevProcesses.Count -gt 0) {
  $details = $existingDevProcesses | ForEach-Object {
    "pid=$($_.Pid) path=$($_.Path) command=$($_.Command)"
  }
  throw @(
    "A development instance for this profile is already running.",
    ($details -join "`n")
  ) -join "`n"
}

$listeners = @(Get-LoopbackListeners -Port $requestedPort)
if ($listeners.Count -gt 0) {
  $conflictProcessIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  $details = foreach ($processId in $conflictProcessIds) {
    $process = Get-ProcessDetails -ProcessId $processId
    "pid=$($process.Pid) path=$($process.Path) command=$($process.Command)"
  }

  $killCommands = foreach ($processId in $conflictProcessIds) {
    "Stop-Process -Id $processId -Force"
  }

  $message = @(
    "Port 127.0.0.1:$requestedPort is already in use.",
    "Conflicting processes:",
    ($details -join "`n"),
    "Para liberar: $($killCommands -join ' ; ')"
  ) -join "`n"
  throw $message
}

$env:CODEX_DESKTOP_DEV_PORT = "$requestedPort"

if ($CheckOnly) {
  Write-Host "Preflight complete. Port 127.0.0.1:$requestedPort is available."
  exit 0
}

Write-Host "Starting Vite at 127.0.0.1:$requestedPort"
& pnpm dev:server
if ($LASTEXITCODE -ne 0) {
  throw "pnpm dev:server failed with exit code $LASTEXITCODE."
}

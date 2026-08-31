[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly,

  [Parameter()]
  [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$exePath = Join-Path $projectRoot "src-tauri\target\release\codex-desktop-next.exe"
. (Join-Path $PSScriptRoot "runtime-profile.ps1")

$existingProcesses = @(Get-ProcessesByExecutablePath -ExecutablePath $exePath)

if ($existingProcesses.Count -gt 0) {
  $pids = ($existingProcesses | Select-Object -ExpandProperty Pid) -join ", "
  throw "Close the current release application before running a release. Processes found: $pids"
}

if ($CheckOnly) {
  Write-Host "Preflight complete: no release instance is running."
  if (Test-Path -LiteralPath $exePath) {
    Write-Host "Existing release executable: $exePath"
  } else {
    Write-Host "No release executable exists; the next build will create it."
  }
  return
}

pnpm build
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build the frontend (pnpm build), exit code $LASTEXITCODE."
}

pnpm tauri build --no-bundle
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build the application (pnpm tauri build --no-bundle), exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $exePath)) {
  throw "The build completed without producing the expected release executable: $exePath"
}

if ($SkipLaunch) {
  Write-Host "Build release executado com sucesso: $exePath"
  return
}

Start-Process -FilePath $exePath | Out-Null
Write-Host "Release started: $exePath"

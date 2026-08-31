[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "project-tools.ps1")

if ($CheckOnly) {
  if (-not (Test-ProjectRipgrep -ProjectRoot $projectRoot)) {
    throw "Local ripgrep is missing or invalid. Run 'pnpm tools:bootstrap'."
  }
  if (-not (Test-ProjectV8 -ProjectRoot $projectRoot)) {
    throw "The local V8 runtime is missing or invalid. Run 'pnpm tools:bootstrap'."
  }
  $ripgrepPath = Get-ProjectRipgrepPath -ProjectRoot $projectRoot
  $v8Paths = Get-ProjectV8Paths -ProjectRoot $projectRoot
  Write-Host "Valid local ripgrep: $ripgrepPath"
  Write-Host "Valid local V8 runtime: $($v8Paths.Root)"
  exit 0
}

$ripgrepPath = Install-ProjectRipgrep -ProjectRoot $projectRoot
$definition = Get-ProjectRipgrepDefinition -ProjectRoot $projectRoot
$v8Paths = Install-ProjectV8 -ProjectRoot $projectRoot
$v8Definition = Get-ProjectV8Definition -ProjectRoot $projectRoot
Write-Host "ripgrep $($definition.Version) is available at $ripgrepPath"
Write-Host "V8 runtime $($v8Definition.Version) is available at $($v8Paths.Root)"

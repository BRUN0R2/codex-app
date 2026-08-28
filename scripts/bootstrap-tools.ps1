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
    throw "ripgrep local ausente ou inválido. Execute 'pnpm tools:bootstrap'."
  }
  if (-not (Test-ProjectV8 -ProjectRoot $projectRoot)) {
    throw "runtime V8 local ausente ou inválido. Execute 'pnpm tools:bootstrap'."
  }
  $ripgrepPath = Get-ProjectRipgrepPath -ProjectRoot $projectRoot
  $v8Paths = Get-ProjectV8Paths -ProjectRoot $projectRoot
  Write-Host "ripgrep local válido: $ripgrepPath"
  Write-Host "runtime V8 local válido: $($v8Paths.Root)"
  exit 0
}

$ripgrepPath = Install-ProjectRipgrep -ProjectRoot $projectRoot
$definition = Get-ProjectRipgrepDefinition -ProjectRoot $projectRoot
$v8Paths = Install-ProjectV8 -ProjectRoot $projectRoot
$v8Definition = Get-ProjectV8Definition -ProjectRoot $projectRoot
Write-Host "ripgrep $($definition.Version) disponível em $ripgrepPath"
Write-Host "runtime V8 $($v8Definition.Version) disponível em $($v8Paths.Root)"

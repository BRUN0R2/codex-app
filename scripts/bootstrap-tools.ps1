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
  $ripgrepPath = Get-ProjectRipgrepPath -ProjectRoot $projectRoot
  Write-Host "ripgrep local válido: $ripgrepPath"
  exit 0
}

$ripgrepPath = Install-ProjectRipgrep -ProjectRoot $projectRoot
Write-Host "ripgrep $script:RipgrepVersion disponível em $ripgrepPath"

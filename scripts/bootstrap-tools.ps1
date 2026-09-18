[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "native-build.ps1")
. (Join-Path $PSScriptRoot "project-tools.ps1")
Initialize-ProjectNativeBuild | Out-Null

if (-not $CheckOnly) {
  Push-Location $projectRoot
  try {
    & cargo fetch --locked --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) {
      throw "cargo fetch failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

if ($CheckOnly) {
  if (-not (Test-ProjectRipgrep -ProjectRoot $projectRoot)) {
    throw "Local ripgrep is missing or invalid. Run 'pnpm tools:bootstrap'."
  }
  if (-not (Test-ProjectV8 -ProjectRoot $projectRoot)) {
    throw "The V8 source ICU data is missing or invalid. Run 'pnpm tools:bootstrap'."
  }
  $ripgrepPath = Get-ProjectRipgrepPath -ProjectRoot $projectRoot
  Write-Host "Valid local ripgrep: $ripgrepPath"
  Write-Host "Valid V8 source ICU data: $(Get-ProjectV8IcuDataPath)"
  exit 0
}

$ripgrepPath = Install-ProjectRipgrep -ProjectRoot $projectRoot
$definition = Get-ProjectRipgrepDefinition -ProjectRoot $projectRoot
$v8IcuDataPath = Install-ProjectV8 -ProjectRoot $projectRoot
Write-Host "ripgrep $($definition.Version) is available at $ripgrepPath"
Write-Host "V8 source ICU data is available at $v8IcuDataPath"

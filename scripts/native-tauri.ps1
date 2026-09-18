[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory)]
  [string]$TauriCommand,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "native-build.ps1")
Initialize-ProjectNativeBuild | Out-Null
$forwardedArguments = @($TauriCommand) + @($TauriArguments)

$exitCode = 1
Push-Location $projectRoot
try {
  & pnpm exec tauri @forwardedArguments
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

exit $exitCode

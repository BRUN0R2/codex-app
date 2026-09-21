[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory)]
  [string]$CargoCommand,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CargoArguments,

  [Parameter()]
  [string]$CargoTrailingArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "native-build.ps1")
Initialize-ProjectNativeBuild | Out-Null
$forwardedArguments = @($CargoCommand) + @($CargoArguments)
$trailingArguments = @()
if (-not [string]::IsNullOrWhiteSpace($CargoTrailingArguments)) {
  $trailingArguments = @($CargoTrailingArguments.Trim() -split "\s+")
}
if ($trailingArguments.Count -gt 0) {
  $forwardedArguments += "--"
  $forwardedArguments += $trailingArguments
}

$exitCode = 1
Push-Location $projectRoot
try {
  & cargo @forwardedArguments
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

exit $exitCode

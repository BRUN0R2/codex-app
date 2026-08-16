param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "project-tools.ps1")

$ripgrepArguments = @($args)
if ($ripgrepArguments.Count -gt 0 -and $ripgrepArguments[0] -eq "--") {
  $ripgrepArguments = @($ripgrepArguments | Select-Object -Skip 1)
}
$ripgrepPath = Enable-ProjectTools -ProjectRoot $projectRoot -Required
& $ripgrepPath @RipgrepArguments
exit $LASTEXITCODE

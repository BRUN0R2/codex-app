[CmdletBinding()]
param(
  [Parameter()]
  [ValidateRange(1, 10)]
  [int]$Samples = 3,

  [Parameter()]
  [ValidateRange(1, 120)]
  [int]$ReadyTimeoutSeconds = 30,

  [Parameter()]
  [ValidateRange(0, 30)]
  [int]$SettleSeconds = 3,

  [Parameter()]
  [string]$Executable = (Join-Path $PSScriptRoot "..\src-tauri\target\release\codex-desktop-next.exe")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$executableName = [IO.Path]::GetFileNameWithoutExtension($resolvedExecutable)
$existingProcesses = @(
  Get-Process -Name $executableName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $resolvedExecutable }
)
if ($existingProcesses.Count -gt 0) {
  throw "Close the existing release application before measuring it."
}
$measurements = @()

for ($sample = 1; $sample -le $Samples; $sample += 1) {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $resolvedExecutable -PassThru
  $ready = $false

  try {
    while ($stopwatch.Elapsed.TotalSeconds -lt $ReadyTimeoutSeconds) {
      Start-Sleep -Milliseconds 50
      $process.Refresh()
      if ($process.HasExited) {
        throw "The release process exited with code $($process.ExitCode) before creating a usable window."
      }
      if ($process.MainWindowHandle -ne 0 -and $process.Responding) {
        $ready = $true
        break
      }
    }

    if (-not $ready) {
      throw "The release window was not ready after $ReadyTimeoutSeconds seconds."
    }

    $startupMilliseconds = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
    if ($SettleSeconds -gt 0) {
      Start-Sleep -Seconds $SettleSeconds
    }
    $process.Refresh()
    if ($process.HasExited) {
      throw "The release process exited while memory was being measured."
    }

    $measurements += [pscustomobject]@{
      sample = $sample
      startupMilliseconds = $startupMilliseconds
      workingSetMiB = [Math]::Round($process.WorkingSet64 / 1MB, 1)
      privateMemoryMiB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
    }
  }
  finally {
    if (-not $process.HasExited) {
      if (-not $process.CloseMainWindow()) {
        throw "The measured process refused a normal window close request."
      }
      if (-not $process.WaitForExit(10000)) {
        throw "The measured process did not exit after a normal window close request."
      }
    }
    $process.Dispose()
  }
}

$startupValues = @($measurements | ForEach-Object { $_.startupMilliseconds } | Sort-Object)
$workingSetValues = @($measurements | ForEach-Object { $_.workingSetMiB })
$privateMemoryValues = @($measurements | ForEach-Object { $_.privateMemoryMiB })
$middle = [Math]::Floor($startupValues.Count / 2)
$medianStartup = if ($startupValues.Count % 2 -eq 0) {
  ($startupValues[$middle - 1] + $startupValues[$middle]) / 2
}
else {
  $startupValues[$middle]
}

[pscustomobject]@{
  measuredAt = (Get-Date).ToUniversalTime().ToString("o")
  executable = $resolvedExecutable
  executableSizeMiB = [Math]::Round((Get-Item -LiteralPath $resolvedExecutable).Length / 1MB, 1)
  logicalProcessorCount = [Environment]::ProcessorCount
  operatingSystem = [Environment]::OSVersion.VersionString
  samples = $measurements
  summary = [pscustomobject]@{
    medianStartupMilliseconds = [Math]::Round($medianStartup, 1)
    averageWorkingSetMiB = [Math]::Round(($workingSetValues | Measure-Object -Average).Average, 1)
    averagePrivateMemoryMiB = [Math]::Round(($privateMemoryValues | Measure-Object -Average).Average, 1)
  }
} | ConvertTo-Json -Depth 5

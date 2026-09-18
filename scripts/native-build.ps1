Set-StrictMode -Version Latest

function Get-ProjectCargoHome {
  $cargoHome = [Environment]::GetEnvironmentVariable("CARGO_HOME")
  if ([string]::IsNullOrWhiteSpace($cargoHome)) {
    $userProfile = [Environment]::GetEnvironmentVariable("USERPROFILE")
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
      throw "CARGO_HOME and USERPROFILE are unavailable."
    }
    $cargoHome = Join-Path $userProfile ".cargo"
  }
  return [System.IO.Path]::GetFullPath($cargoHome)
}

function Get-ProjectNativeTargetDirectory {
  $cargoHome = Get-ProjectCargoHome
  $configuredTarget = [Environment]::GetEnvironmentVariable("CARGO_TARGET_DIR")
  $targetDirectory = if ([string]::IsNullOrWhiteSpace($configuredTarget)) {
    Join-Path $cargoHome "target\codex-desktop-next"
  } else {
    [System.IO.Path]::GetFullPath($configuredTarget)
  }
  $targetDirectory = [System.IO.Path]::GetFullPath($targetDirectory)
  $cargoVolume = [System.IO.Path]::GetPathRoot($cargoHome)
  $targetVolume = [System.IO.Path]::GetPathRoot($targetDirectory)
  if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($cargoVolume, $targetVolume)) {
    throw "CARGO_TARGET_DIR must use the same volume as CARGO_HOME for the sandboxed V8 build."
  }

  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  return ConvertTo-ProjectShortPath -Path $targetDirectory
}

function ConvertTo-ProjectShortPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if ($Path -notmatch "\s") {
    return $Path
  }
  if (-not $IsWindows) {
    throw "The native target path contains whitespace, which is unsupported by the Windows V8 build: $Path"
  }
  if ($null -eq ("CodexNativeBuild.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexNativeBuild
{
    public static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetShortPathName(
            string longPath,
            StringBuilder shortPath,
            uint bufferLength);
    }
}
"@
  }
  $buffer = [System.Text.StringBuilder]::new(32768)
  $length = [CodexNativeBuild.NativeMethods]::GetShortPathName($Path, $buffer, $buffer.Capacity)
  if ($length -eq 0) {
    throw "Windows could not produce a short native target path for: $Path"
  }
  $shortPath = $buffer.ToString()
  if ($shortPath -match "\s") {
    throw "The native target path still contains whitespace after normalization: $shortPath"
  }
  return $shortPath
}

function Get-ProjectPythonExecutable {
  $configuredPython = [Environment]::GetEnvironmentVariable("PYTHON")
  $pythonCommand = if ([string]::IsNullOrWhiteSpace($configuredPython)) {
    "python"
  } else {
    $configuredPython
  }
  try {
    $command = Get-Command -Name $pythonCommand -ErrorAction Stop
  } catch {
    throw "Python is required by the sandboxed V8 source build. Install Python 3 and make it available as '$pythonCommand'."
  }

  $pythonLines = @(& $command.Source -c "import sys; print(sys.executable)" 2>$null)
  if ($LASTEXITCODE -ne 0 -or $pythonLines.Count -ne 1) {
    throw "The configured Python interpreter could not report its executable path: $($command.Source)"
  }
  $pythonExecutable = $pythonLines[0].ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($pythonExecutable) -or
    -not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
    throw "Python reported an invalid executable path: $pythonExecutable"
  }
  return [System.IO.Path]::GetFullPath($pythonExecutable)
}

function Get-ProjectNativeBuildJobs {
  $projectJobs = [Environment]::GetEnvironmentVariable("CODEX_NATIVE_BUILD_JOBS")
  $cargoJobs = [Environment]::GetEnvironmentVariable("CARGO_BUILD_JOBS")
  if (-not [string]::IsNullOrWhiteSpace($projectJobs) -and
    -not [string]::IsNullOrWhiteSpace($cargoJobs) -and
    $projectJobs.Trim() -ne $cargoJobs.Trim()) {
    throw "CODEX_NATIVE_BUILD_JOBS and CARGO_BUILD_JOBS must agree when both are set."
  }
  $requestedJobs = if (-not [string]::IsNullOrWhiteSpace($projectJobs)) {
    $projectJobs.Trim()
  } elseif (-not [string]::IsNullOrWhiteSpace($cargoJobs)) {
    $cargoJobs.Trim()
  } else {
    [Math]::Min(8, [Environment]::ProcessorCount).ToString()
  }
  $jobs = 0
  if (-not [int]::TryParse($requestedJobs, [ref]$jobs) -or
    $jobs -lt 1 -or $jobs -gt [Environment]::ProcessorCount) {
    throw "Native build jobs must be an integer between 1 and $([Environment]::ProcessorCount)."
  }
  return $jobs
}

function Initialize-ProjectNativeBuild {
  $targetDirectory = Get-ProjectNativeTargetDirectory
  $env:CARGO_TARGET_DIR = $targetDirectory
  $env:PYTHON = Get-ProjectPythonExecutable
  $env:CARGO_BUILD_JOBS = "$(Get-ProjectNativeBuildJobs)"
  return $targetDirectory
}

function Get-ProjectNativeExecutablePath {
  param(
    [Parameter(Mandatory)]
    [ValidateSet("debug", "release")]
    [string]$Profile
  )

  return Join-Path (Get-ProjectNativeTargetDirectory) "$Profile\codex-desktop-next.exe"
}

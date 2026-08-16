Set-StrictMode -Version Latest

$script:RipgrepVersion = "15.2.0"
$script:RipgrepReleaseBaseUrl = "https://github.com/BurntSushi/ripgrep/releases/download"

function Get-ProjectRipgrepDefinition {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  switch ($architecture) {
    "X64" {
      return [pscustomobject]@{
        Architecture = "x64"
        AssetName = "ripgrep-$script:RipgrepVersion-x86_64-pc-windows-msvc.zip"
        ArchiveSha256 = "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"
        ExecutableSha256 = "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680"
      }
    }
    "Arm64" {
      return [pscustomobject]@{
        Architecture = "arm64"
        AssetName = "ripgrep-$script:RipgrepVersion-aarch64-pc-windows-msvc.zip"
        ArchiveSha256 = "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f"
        ExecutableSha256 = "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c"
      }
    }
    default {
      throw "Arquitetura Windows não suportada para o ripgrep local: $architecture."
    }
  }
}

function Get-ProjectRipgrepPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $definition = Get-ProjectRipgrepDefinition
  return Join-Path $ProjectRoot ".tools\ripgrep\$script:RipgrepVersion\$($definition.Architecture)\rg.exe"
}

function Get-ProjectToolSha256 {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

function Test-ProjectRipgrep {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $definition = Get-ProjectRipgrepDefinition
  $executablePath = Get-ProjectRipgrepPath -ProjectRoot $ProjectRoot
  if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    return $false
  }
  if ((Get-ProjectToolSha256 -Path $executablePath) -ne $definition.ExecutableSha256) {
    return $false
  }

  $versionOutput = @(& $executablePath --version 2>$null)
  return $LASTEXITCODE -eq 0 -and
    $versionOutput.Count -gt 0 -and
    $versionOutput[0] -eq "ripgrep $script:RipgrepVersion (rev e89fff89ac)"
}

function Install-ProjectRipgrep {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  if (Test-ProjectRipgrep -ProjectRoot $resolvedProjectRoot) {
    return Get-ProjectRipgrepPath -ProjectRoot $resolvedProjectRoot
  }

  $definition = Get-ProjectRipgrepDefinition
  $toolsRoot = Join-Path $resolvedProjectRoot ".tools\ripgrep"
  $targetDirectory = Join-Path $toolsRoot "$script:RipgrepVersion\$($definition.Architecture)"
  $stagingDirectory = Join-Path $toolsRoot (".staging-{0}" -f [System.Guid]::NewGuid().ToString("N"))
  $archivePath = Join-Path $stagingDirectory $definition.AssetName
  $extractDirectory = Join-Path $stagingDirectory "extract"
  $downloadUrl = "$script:RipgrepReleaseBaseUrl/$script:RipgrepVersion/$($definition.AssetName)"
  $backupDirectory = $null

  New-Item -ItemType Directory -Path $extractDirectory -Force | Out-Null
  try {
    $previousProgressPreference = $ProgressPreference
    try {
      $ProgressPreference = "SilentlyContinue"
      Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -ErrorAction Stop
    } finally {
      $ProgressPreference = $previousProgressPreference
    }

    $archiveSha256 = Get-ProjectToolSha256 -Path $archivePath
    if ($archiveSha256 -ne $definition.ArchiveSha256) {
      throw "SHA-256 inválido para $($definition.AssetName): esperado $($definition.ArchiveSha256), recebido $archiveSha256."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractDirectory)
    $executables = @(Get-ChildItem -LiteralPath $extractDirectory -Recurse -File -Filter "rg.exe")
    if ($executables.Count -ne 1) {
      throw "O asset do ripgrep deveria conter exatamente um rg.exe; encontrados: $($executables.Count)."
    }
    $executableSha256 = Get-ProjectToolSha256 -Path $executables[0].FullName
    if ($executableSha256 -ne $definition.ExecutableSha256) {
      throw "SHA-256 inválido para rg.exe: esperado $($definition.ExecutableSha256), recebido $executableSha256."
    }

    $releaseDirectory = $executables[0].Directory.FullName
    $targetParent = Split-Path -Parent $targetDirectory
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    if (Test-Path -LiteralPath $targetDirectory) {
      $backupDirectory = "$targetDirectory.invalid-$([System.Guid]::NewGuid().ToString("N"))"
      Move-Item -LiteralPath $targetDirectory -Destination $backupDirectory
    }
    try {
      Move-Item -LiteralPath $releaseDirectory -Destination $targetDirectory
      if (-not (Test-ProjectRipgrep -ProjectRoot $resolvedProjectRoot)) {
        throw "A instalação concluída do ripgrep não passou na validação final."
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force
      }
    } catch {
      if (Test-Path -LiteralPath $targetDirectory) {
        Remove-Item -LiteralPath $targetDirectory -Recurse -Force
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Move-Item -LiteralPath $backupDirectory -Destination $targetDirectory
      }
      throw
    }
    return Get-ProjectRipgrepPath -ProjectRoot $resolvedProjectRoot
  } finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
      Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
  }
}

function Enable-ProjectTools {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,

    [Parameter()]
    [switch]$Required
  )

  $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  if (-not (Test-ProjectRipgrep -ProjectRoot $resolvedProjectRoot)) {
    $message = "ripgrep local ausente ou inválido. Execute 'pnpm tools:bootstrap'."
    if ($Required) {
      throw $message
    }
    Write-Host $message
    return $null
  }

  $executablePath = Get-ProjectRipgrepPath -ProjectRoot $resolvedProjectRoot
  $toolDirectory = Split-Path -Parent $executablePath
  $pathEntries = @($env:PATH -split [System.IO.Path]::PathSeparator)
  if (-not ($pathEntries | Where-Object {
    [System.StringComparer]::OrdinalIgnoreCase.Equals($_, $toolDirectory)
  })) {
    $env:PATH = "$toolDirectory$([System.IO.Path]::PathSeparator)$env:PATH"
  }
  return $executablePath
}

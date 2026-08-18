Set-StrictMode -Version Latest

function Get-ProjectRipgrepManifest {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifestPath = Join-Path $ProjectRoot "scripts\ripgrep-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Manifesto do ripgrep ausente: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -Depth 10
  if ($manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($manifest.version)) {
    throw "Manifesto do ripgrep inválido: $manifestPath"
  }
  return $manifest
}

function Get-ProjectRipgrepDefinition {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectRipgrepManifest -ProjectRoot $ProjectRoot
  $runtimeArchitecture =
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  $target = switch ($runtimeArchitecture) {
    "X64" { "x86_64-pc-windows-msvc" }
    "Arm64" { "aarch64-pc-windows-msvc" }
    default {
      throw "Arquitetura Windows não suportada para o ripgrep local: $runtimeArchitecture."
    }
  }
  $definition = $manifest.targets.PSObject.Properties[$target].Value
  if ($null -eq $definition) {
    throw "O manifesto do ripgrep não define o alvo $target."
  }
  return [pscustomobject]@{
    Version = [string]$manifest.version
    Revision = [string]$manifest.revision
    ReleaseBaseUrl = [string]$manifest.releaseBaseUrl
    Target = $target
    Architecture = [string]$definition.architecture
    AssetName = [string]$definition.assetName
    ArchiveSha256 = [string]$definition.archiveSha256
    ExecutableSha256 = [string]$definition.executableSha256
  }
}

function Get-ProjectRipgrepPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $definition = Get-ProjectRipgrepDefinition -ProjectRoot $ProjectRoot
  return Join-Path $ProjectRoot ".tools\ripgrep\$($definition.Version)\$($definition.Architecture)\rg.exe"
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

  $definition = Get-ProjectRipgrepDefinition -ProjectRoot $ProjectRoot
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
    $versionOutput[0] -eq "ripgrep $($definition.Version) (rev $($definition.Revision))"
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

  $definition = Get-ProjectRipgrepDefinition -ProjectRoot $resolvedProjectRoot
  $toolsRoot = Join-Path $resolvedProjectRoot ".tools\ripgrep"
  $targetDirectory = Join-Path $toolsRoot "$($definition.Version)\$($definition.Architecture)"
  $stagingDirectory = Join-Path $toolsRoot (".staging-{0}" -f [System.Guid]::NewGuid().ToString("N"))
  $archivePath = Join-Path $stagingDirectory $definition.AssetName
  $extractDirectory = Join-Path $stagingDirectory "extract"
  $downloadUrl = "$($definition.ReleaseBaseUrl)/$($definition.Version)/$($definition.AssetName)"
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

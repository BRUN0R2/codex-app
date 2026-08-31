Set-StrictMode -Version Latest

function Get-ProjectWindowsTarget {
  $requestedTarget = [Environment]::GetEnvironmentVariable("CARGO_BUILD_TARGET")
  if (-not [string]::IsNullOrWhiteSpace($requestedTarget)) {
    $target = $requestedTarget.Trim()
    if ($target -notin @("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")) {
      throw "Windows target is not supported by the local tools: $target."
    }
    return $target
  }

  $runtimeArchitecture =
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  switch ($runtimeArchitecture) {
    "X64" { return "x86_64-pc-windows-msvc" }
    "Arm64" { return "aarch64-pc-windows-msvc" }
    default {
      throw "Windows architecture is not supported by the local tools: $runtimeArchitecture."
    }
  }
}

function Get-ProjectRipgrepManifest {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifestPath = Join-Path $ProjectRoot "scripts\ripgrep-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing ripgrep manifest: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -Depth 10
  if ($manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($manifest.version)) {
    throw "Invalid ripgrep manifest: $manifestPath"
  }
  return $manifest
}

function Get-ProjectRipgrepDefinition {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectRipgrepManifest -ProjectRoot $ProjectRoot
  $target = Get-ProjectWindowsTarget
  $definition = $manifest.targets.PSObject.Properties[$target].Value
  if ($null -eq $definition) {
    throw "The ripgrep manifest does not define target $target."
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
      throw "Invalid SHA-256 for $($definition.AssetName): expected $($definition.ArchiveSha256), received $archiveSha256."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractDirectory)
    $executables = @(Get-ChildItem -LiteralPath $extractDirectory -Recurse -File -Filter "rg.exe")
    if ($executables.Count -ne 1) {
      throw "The ripgrep asset must contain exactly one rg.exe; found: $($executables.Count)."
    }
    $executableSha256 = Get-ProjectToolSha256 -Path $executables[0].FullName
    if ($executableSha256 -ne $definition.ExecutableSha256) {
      throw "Invalid SHA-256 for rg.exe: expected $($definition.ExecutableSha256), received $executableSha256."
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
        throw "The completed ripgrep installation failed final validation."
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

function Get-ProjectV8Definition {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifestPath = Join-Path $ProjectRoot "scripts\v8-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing V8 manifest: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -Depth 10
  if (
    $manifest.schemaVersion -ne 1 -or
    [string]::IsNullOrWhiteSpace($manifest.version) -or
    [string]::IsNullOrWhiteSpace($manifest.releaseBaseUrl)
  ) {
    throw "Invalid V8 manifest: $manifestPath"
  }

  $target = Get-ProjectWindowsTarget
  $targetDefinition = $manifest.targets.PSObject.Properties[$target].Value
  if (
    $null -eq $targetDefinition -or
    [string]::IsNullOrWhiteSpace($targetDefinition.archiveAssetName) -or
    [string]::IsNullOrWhiteSpace($targetDefinition.archiveSha256) -or
    [string]::IsNullOrWhiteSpace($targetDefinition.bindingAssetName) -or
    [string]::IsNullOrWhiteSpace($targetDefinition.bindingSha256)
  ) {
    throw "The V8 manifest does not fully define target $target."
  }

  return [pscustomobject]@{
    Version = [string]$manifest.version
    ReleaseBaseUrl = [string]$manifest.releaseBaseUrl
    Target = $target
    ArchiveAssetName = [string]$targetDefinition.archiveAssetName
    ArchiveSha256 = [string]$targetDefinition.archiveSha256
    BindingAssetName = [string]$targetDefinition.bindingAssetName
    BindingSha256 = [string]$targetDefinition.bindingSha256
  }
}

function Get-ProjectV8Paths {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $root = Join-Path $ProjectRoot ".tools\v8\current"
  return [pscustomobject]@{
    Root = $root
    Archive = Join-Path $root "rusty_v8.lib.gz"
    Binding = Join-Path $root "src_binding.rs"
  }
}

function Test-ProjectV8 {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $definition = Get-ProjectV8Definition -ProjectRoot $ProjectRoot
  $paths = Get-ProjectV8Paths -ProjectRoot $ProjectRoot
  if (
    -not (Test-Path -LiteralPath $paths.Archive -PathType Leaf) -or
    -not (Test-Path -LiteralPath $paths.Binding -PathType Leaf)
  ) {
    return $false
  }
  return (
    (Get-ProjectToolSha256 -Path $paths.Archive) -eq $definition.ArchiveSha256 -and
    (Get-ProjectToolSha256 -Path $paths.Binding) -eq $definition.BindingSha256
  )
}

function Install-ProjectV8 {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  if (Test-ProjectV8 -ProjectRoot $resolvedProjectRoot) {
    return Get-ProjectV8Paths -ProjectRoot $resolvedProjectRoot
  }

  $definition = Get-ProjectV8Definition -ProjectRoot $resolvedProjectRoot
  $paths = Get-ProjectV8Paths -ProjectRoot $resolvedProjectRoot
  $toolsRoot = Join-Path $resolvedProjectRoot ".tools\v8"
  $stagingDirectory = Join-Path $toolsRoot (".staging-{0}" -f [System.Guid]::NewGuid().ToString("N"))
  $stagingArchive = Join-Path $stagingDirectory "rusty_v8.lib.gz"
  $stagingBinding = Join-Path $stagingDirectory "src_binding.rs"
  $archiveUrl = "$($definition.ReleaseBaseUrl)/$($definition.ArchiveAssetName)"
  $bindingUrl = "$($definition.ReleaseBaseUrl)/$($definition.BindingAssetName)"
  $backupDirectory = $null

  New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
  try {
    $previousProgressPreference = $ProgressPreference
    try {
      $ProgressPreference = "SilentlyContinue"
      Invoke-WebRequest -Uri $archiveUrl -OutFile $stagingArchive -ErrorAction Stop
      Invoke-WebRequest -Uri $bindingUrl -OutFile $stagingBinding -ErrorAction Stop
    } finally {
      $ProgressPreference = $previousProgressPreference
    }

    $archiveSha256 = Get-ProjectToolSha256 -Path $stagingArchive
    if ($archiveSha256 -ne $definition.ArchiveSha256) {
      throw "Invalid SHA-256 for $($definition.ArchiveAssetName): expected $($definition.ArchiveSha256), received $archiveSha256."
    }
    $bindingSha256 = Get-ProjectToolSha256 -Path $stagingBinding
    if ($bindingSha256 -ne $definition.BindingSha256) {
      throw "Invalid SHA-256 for $($definition.BindingAssetName): expected $($definition.BindingSha256), received $bindingSha256."
    }

    if (Test-Path -LiteralPath $paths.Root) {
      $backupDirectory = "$($paths.Root).invalid-$([System.Guid]::NewGuid().ToString("N"))"
      Move-Item -LiteralPath $paths.Root -Destination $backupDirectory
    }
    try {
      Move-Item -LiteralPath $stagingDirectory -Destination $paths.Root
      if (-not (Test-ProjectV8 -ProjectRoot $resolvedProjectRoot)) {
        throw "The completed V8 runtime installation failed final validation."
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force
      }
    } catch {
      if (Test-Path -LiteralPath $paths.Root) {
        Remove-Item -LiteralPath $paths.Root -Recurse -Force
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Move-Item -LiteralPath $backupDirectory -Destination $paths.Root
      }
      throw
    }
    return Get-ProjectV8Paths -ProjectRoot $resolvedProjectRoot
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
    $message = "Local ripgrep is missing or invalid. Run 'pnpm tools:bootstrap'."
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

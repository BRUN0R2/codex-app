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

function Get-ProjectV8SourceManifest {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifestPath = Join-Path $ProjectRoot "scripts\v8-source-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing V8 source manifest: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -Depth 10
  $rust = $manifest.chromiumRust
  if ($manifest.schemaVersion -ne 1 -or
    [string]::IsNullOrWhiteSpace($manifest.crateVersion) -or
    [string]::IsNullOrWhiteSpace($manifest.icuDataPackage) -or
    [string]::IsNullOrWhiteSpace($manifest.icuDataSha256) -or
    $null -eq $rust -or
    [string]::IsNullOrWhiteSpace($rust.repository) -or
    [string]::IsNullOrWhiteSpace($rust.commit) -or
    [string]::IsNullOrWhiteSpace($rust.archiveUrl) -or
    [string]::IsNullOrWhiteSpace($rust.vendorDirectory) -or
    [string]::IsNullOrWhiteSpace($rust.manifestSha256) -or
    [string]::IsNullOrWhiteSpace($rust.markerPath) -or
    [string]::IsNullOrWhiteSpace($rust.treeSha256)) {
    throw "Invalid V8 source manifest: $manifestPath"
  }
  if ($rust.archiveUrl -notlike "*$($rust.commit)*") {
    throw "The Chromium Rust archive URL does not pin commit $($rust.commit)."
  }
  return $manifest
}

function Get-ProjectCanonicalTreeSha256 {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $root = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@("\", "/"))
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Cannot hash missing directory: $root"
  }

  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length).TrimStart("\").Replace("\", "/")
    $lines.Add("$relative`n$(Get-ProjectToolSha256 -Path $file.FullName)")
  }
  $lines.Sort([System.StringComparer]::Ordinal)
  $catalog = if ($lines.Count -eq 0) {
    ""
  } else {
    [string]::Join("`n", $lines) + "`n"
  }

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString(
      $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($catalog))
    )).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-ProjectV8PackagePath {
  param(
    [Parameter(Mandatory)]
    [string]$PackageName
  )

  $registrySource = Join-Path (Get-ProjectCargoHome) "registry\src"
  if (-not (Test-Path -LiteralPath $registrySource -PathType Container)) {
    throw "Cargo registry source is unavailable: $registrySource. Run 'cargo fetch' first."
  }

  $candidates = @(
    foreach ($index in Get-ChildItem -LiteralPath $registrySource -Directory) {
      $package = Join-Path $index.FullName $packageName
      if (Test-Path -LiteralPath $package -PathType Container) {
        $package
      }
    }
  )
  if ($candidates.Count -eq 0) {
    throw "Cargo registry does not contain $packageName. Run 'cargo fetch' first."
  }
  if ($candidates.Count -ne 1) {
    throw "Cargo registry contains multiple $packageName packages."
  }
  return $candidates[0]
}

function Get-ProjectV8SourcePath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  return Get-ProjectV8PackagePath -PackageName "v8-$($manifest.crateVersion)"
}

function Get-ProjectV8IcuDataPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  return Join-Path (Get-ProjectV8SourcePath -ProjectRoot $ProjectRoot) "third_party\icu\common\icudtl.dat"
}

function Get-ProjectV8RustVendorPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  return Join-Path (Get-ProjectV8SourcePath -ProjectRoot $ProjectRoot) (
    Join-Path "third_party\rust" $manifest.chromiumRust.vendorDirectory
  )
}

function Get-ProjectV8RustVendorMarkerPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $path = Get-ProjectV8RustVendorPath -ProjectRoot $ProjectRoot
  foreach ($part in @($manifest.chromiumRust.markerPath -split "/")) {
    $path = Join-Path $path $part
  }
  return $path
}

function Get-ProjectV8RustVendorManifestPath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  return Join-Path (Get-ProjectV8RustVendorPath -ProjectRoot $ProjectRoot) "Cargo.toml"
}

function Get-ProjectIcuDataSourcePath {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $package = Get-ProjectV8PackagePath -PackageName $manifest.icuDataPackage
  $dataPath = Join-Path $package "src\icudtl.dat"
  if (-not (Test-Path -LiteralPath $dataPath -PathType Leaf)) {
    throw "Cargo registry does not contain the exact ICU data package $($manifest.icuDataPackage). Run 'cargo fetch' first."
  }
  return $dataPath
}

function Test-ProjectV8Vendor {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $vendorManifest = Get-ProjectV8RustVendorManifestPath -ProjectRoot $ProjectRoot
  return (Test-Path -LiteralPath $vendorManifest -PathType Leaf) -and
    (Get-ProjectToolSha256 -Path $vendorManifest) -eq $manifest.chromiumRust.manifestSha256 -and
    (Test-Path -LiteralPath (Get-ProjectV8RustVendorMarkerPath -ProjectRoot $ProjectRoot) -PathType Leaf)
}

function Test-ProjectV8 {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $dataPath = Get-ProjectV8IcuDataPath -ProjectRoot $ProjectRoot
  $dataValid = (Test-Path -LiteralPath $dataPath -PathType Leaf) -and
    (Get-ProjectToolSha256 -Path $dataPath) -eq $manifest.icuDataSha256
  return $dataValid -and (Test-ProjectV8Vendor -ProjectRoot $ProjectRoot)
}

function Install-ProjectV8RustVendor {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $rust = $manifest.chromiumRust
  $stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-v8-rust-{0}" -f [System.Guid]::NewGuid().ToString("N"))
  $archivePath = Join-Path $stagingDirectory "chromium-rust.tar.gz"
  $extractDirectory = Join-Path $stagingDirectory "extract"
  $destination = Get-ProjectV8RustVendorPath -ProjectRoot $ProjectRoot
  $destinationRoot = Split-Path -Parent $destination
  $backupDirectory = $null

  New-Item -ItemType Directory -Path $extractDirectory -Force | Out-Null
  try {
    $previousProgressPreference = $ProgressPreference
    try {
      $ProgressPreference = "SilentlyContinue"
      Invoke-WebRequest -Uri $rust.archiveUrl -OutFile $archivePath -ErrorAction Stop
    } finally {
      $ProgressPreference = $previousProgressPreference
    }

    # Gitiles +archive tarballs are not bit-stable across regenerations. Integrity
    # is the pinned git commit in the URL plus the extracted vendor tree digest.
    $tar = Get-Command tar -ErrorAction Stop
    & $tar.Source -xzf $archivePath -C $extractDirectory
    if ($LASTEXITCODE -ne 0) {
      throw "The Chromium Rust archive could not be extracted."
    }
    $extractedVendor = Join-Path $extractDirectory $rust.vendorDirectory
    $extractedManifest = Join-Path $extractedVendor "Cargo.toml"
    $extractedMarker = $extractedVendor
    foreach ($part in @($rust.markerPath -split "/")) {
      $extractedMarker = Join-Path $extractedMarker $part
    }
    if (-not (Test-Path -LiteralPath $extractedMarker -PathType Leaf) -or
      -not (Test-Path -LiteralPath $extractedManifest -PathType Leaf) -or
      (Get-ProjectToolSha256 -Path $extractedManifest) -ne $rust.manifestSha256) {
      throw "The Chromium Rust archive does not contain the expected vendored crates."
    }
    $treeSha256 = Get-ProjectCanonicalTreeSha256 -Path $extractedVendor
    if ($treeSha256 -ne $rust.treeSha256) {
      throw "Invalid Chromium Rust vendor tree: expected $($rust.treeSha256), received $treeSha256."
    }

    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
      $backupDirectory = "$destination.invalid-$([System.Guid]::NewGuid().ToString("N"))"
      Move-Item -LiteralPath $destination -Destination $backupDirectory
    }
    try {
      Move-Item -LiteralPath $extractedVendor -Destination $destination
      if (-not (Test-Path -LiteralPath (Get-ProjectV8RustVendorMarkerPath -ProjectRoot $ProjectRoot) -PathType Leaf) -or
        (Get-ProjectToolSha256 -Path (Get-ProjectV8RustVendorManifestPath -ProjectRoot $ProjectRoot)) -ne
        $rust.manifestSha256 -or
        (Get-ProjectCanonicalTreeSha256 -Path $destination) -ne $rust.treeSha256) {
        throw "The completed Chromium Rust source installation failed validation."
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force
      }
    } catch {
      if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
      }
      if ($null -ne $backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
        Move-Item -LiteralPath $backupDirectory -Destination $destination
      }
      throw
    }
  } finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
      Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
  }
}

function Install-ProjectV8 {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $manifest = Get-ProjectV8SourceManifest -ProjectRoot $ProjectRoot
  $dataPath = Get-ProjectV8IcuDataPath -ProjectRoot $ProjectRoot
  if (-not (Test-ProjectV8 -ProjectRoot $ProjectRoot)) {
    if (-not (Test-ProjectV8Vendor -ProjectRoot $ProjectRoot)) {
      Install-ProjectV8RustVendor -ProjectRoot $ProjectRoot
    }

    $sourcePath = Get-ProjectIcuDataSourcePath -ProjectRoot $ProjectRoot
    $sourceSha256 = Get-ProjectToolSha256 -Path $sourcePath
    if ($sourceSha256 -ne $manifest.icuDataSha256) {
      throw "Invalid SHA-256 for $sourcePath`: expected $($manifest.icuDataSha256), received $sourceSha256."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dataPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $dataPath -Force
  }
  if (-not (Test-ProjectV8 -ProjectRoot $ProjectRoot)) {
    throw "The completed V8 source dependency installation failed final validation."
  }
  return $dataPath
}

function Enable-ProjectTools {
  param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
  )

  $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  if (-not (Test-ProjectRipgrep -ProjectRoot $resolvedProjectRoot)) {
    throw "Local ripgrep is missing or invalid. Run 'pnpm tools:bootstrap'."
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

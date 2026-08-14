[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly,

  [Parameter()]
  [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$exePath = Join-Path $projectRoot "src-tauri\target\release\codex-desktop-next.exe"
. (Join-Path $PSScriptRoot "runtime-profile.ps1")

$existingProcesses = @(Get-ProcessesByExecutablePath -ExecutablePath $exePath)

if ($existingProcesses.Count -gt 0) {
  $pids = ($existingProcesses | Select-Object -ExpandProperty Pid) -join ", "
  throw "Feche o aplicativo release atual antes de executar a release. Processos encontrados: $pids"
}

if ($CheckOnly) {
  Write-Host "Sanidade concluída: sem instância release em execução."
  if (Test-Path -LiteralPath $exePath) {
    Write-Host "Executável release existente: $exePath"
  } else {
    Write-Host "Nenhum executável release existente; ele será criado no próximo build."
  }
  return
}

pnpm build
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao compilar o frontend (pnpm build), código $LASTEXITCODE."
}

pnpm tauri build --no-bundle
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao compilar o aplicativo (pnpm tauri build --no-bundle), código $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $exePath)) {
  throw "A compilação terminou sem gerar o executável release esperado: $exePath"
}

if ($SkipLaunch) {
  Write-Host "Build release executado com sucesso: $exePath"
  return
}

Start-Process -FilePath $exePath | Out-Null
Write-Host "Release lançado: $exePath"

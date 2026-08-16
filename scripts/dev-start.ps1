[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$defaultPort = 1420
$devIdentifier = "dev.codexapp.desktop.dev"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$debugExecutablePath = Join-Path $projectRoot "src-tauri\target\debug\codex-desktop-next.exe"
$tempConfigPath = Join-Path $env:TEMP ("codex-tauri-dev-{0}.json" -f ([System.Guid]::NewGuid().ToString("N")))
. (Join-Path $PSScriptRoot "runtime-profile.ps1")
. (Join-Path $PSScriptRoot "project-tools.ps1")
Enable-ProjectTools -ProjectRoot $projectRoot | Out-Null

$requestedPort = $defaultPort

if ($env:CODEX_DESKTOP_DEV_PORT) {
  $value = $env:CODEX_DESKTOP_DEV_PORT
  if (-not [int]::TryParse($value, [ref]$requestedPort)) {
    throw "A variável CODEX_DESKTOP_DEV_PORT precisa ser um número inteiro entre 1 e 65535."
  }
} elseif ($env:VITE_PORT) {
  $value = $env:VITE_PORT
  if (-not [int]::TryParse($value, [ref]$requestedPort)) {
    throw "A variável VITE_PORT precisa ser um número inteiro entre 1 e 65535."
  }
}

if ($requestedPort -lt 1 -or $requestedPort -gt 65535) {
  throw "Porta inválida para desenvolvimento: $requestedPort. Use um valor entre 1 e 65535."
}

$existingDevProcesses = @(Get-ProcessesByExecutablePath -ExecutablePath $debugExecutablePath)
if ($existingDevProcesses.Count -gt 0) {
  $processes = $existingDevProcesses | ForEach-Object {
    "pid=$($_.Pid) caminho=$($_.Path) comando=$($_.Command)"
  }
  throw @(
    "Já existe uma instância dev deste perfil em execução.",
    ($processes -join "`n")
  ) -join "`n"
}

$listeners = @(Get-LoopbackListeners -Port $requestedPort)
if ($listeners.Count -gt 0) {
  $details = $listeners |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Get-ProcessDetails -ProcessId $_ } |
    ForEach-Object { "pid=$($_.Pid) caminho=$($_.Path) comando=$($_.Command)" }
  throw @(
    "A porta fixa do perfil dev, 127.0.0.1:$requestedPort, já está em uso.",
    ($details -join "`n")
  ) -join "`n"
}

$devUrl = "http://127.0.0.1:$requestedPort"
$baseConfig = Get-Content -Path $tauriConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json -Depth 20
$baseDevCsp = $null

if ($null -ne $baseConfig -and $baseConfig.PSObject.Properties.Name -contains "app") {
  $appConfig = $baseConfig.app
  if ($null -ne $appConfig -and $appConfig.PSObject.Properties.Name -contains "security") {
    $securityConfig = $appConfig.security
    if ($null -ne $securityConfig -and $securityConfig.PSObject.Properties.Name -contains "devCsp") {
      $baseDevCsp = $securityConfig.devCsp
    }
  }
}

$runtimeDevCsp = if ([string]::IsNullOrWhiteSpace($baseDevCsp)) {
  $baseDevCsp
} else {
  $baseDevCsp -replace "ws://127\\.0\\.0\\.1:\\d+", ("ws://127.0.0.1:{0}" -f $requestedPort)
}

$runtimeConfig = [ordered]@{
  identifier = $devIdentifier
  productName = "Codex App Dev"
  build = @{
    beforeDevCommand = "pnpm dev:server"
    devUrl = $devUrl
  }
}

if ($runtimeDevCsp) {
  $runtimeConfig.app = @{
    security = @{
      devCsp = $runtimeDevCsp
    }
  }
}

try {
  $runtimeConfig |
    ConvertTo-Json -Depth 20 |
    Set-Content -Path $tempConfigPath -Encoding UTF8
} catch {
  throw "Falha ao gerar a configuração de execução em $tempConfigPath. $_"
}

$env:CODEX_DESKTOP_DEV_PORT = "$requestedPort"
Write-Host "Iniciando dev em $devUrl"

$exitCode = 1
try {
  & pnpm tauri dev --config $tempConfigPath
  $exitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempConfigPath -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
  throw "pnpm tauri dev falhou com código $exitCode."
}

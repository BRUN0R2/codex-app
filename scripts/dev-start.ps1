[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$loopbackAddresses = @("127.0.0.1", "::1", "localhost")
$defaultPort = 1420
$maxProbePorts = 120

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$tempConfigPath = Join-Path $env:TEMP ("codex-tauri-dev-{0}.json" -f ([System.Guid]::NewGuid().ToString("N")))

function Get-ListeningProcesses {
  param([int]$Port)

  try {
    return Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in $loopbackAddresses }
  } catch {
    Write-Warning "Não foi possível consultar conexões TCP locais. Continue com cautela."
    return @()
  }
}

function Get-PortOwnerDetails {
  param([int[]]$ProcessIds)

  foreach ($processId in $ProcessIds) {
    $process = $null
    try {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    } catch {}

    $path = if ($process -and $process.ExecutablePath) { $process.ExecutablePath } else { "<desconhecido>" }
    $command = if ($process -and $process.CommandLine) { $process.CommandLine } else { "node" }

    [pscustomobject]@{
      Pid = $processId
      Path = $path
      Command = $command
    }
  }
}

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

$resolvedPort = $requestedPort
$current = @(Get-ListeningProcesses -Port $resolvedPort)
$attempt = 0
while ($current.Count -gt 0) {
  if ($attempt -ge $maxProbePorts -or ($requestedPort + $attempt + 1) -gt 65535) {
    $conflictIds = $current | Select-Object -ExpandProperty OwningProcess -Unique
    $conflictDetails = Get-PortOwnerDetails -ProcessIds $conflictIds
    $detailsText = $conflictDetails | ForEach-Object {
      "pid=$($_.Pid) caminho=$($_.Path) comando=$($_.Command)"
    }

    throw @(
      "Não foi possível localizar uma porta livre entre $requestedPort e $($requestedPort + $maxProbePorts).",
      "A porta inicial em conflito tinha processos:",
      $detailsText -join "`n"
    ) -join "`n"
  }

  $resolvedPort += 1
  $attempt += 1
  $current = @(Get-ListeningProcesses -Port $resolvedPort)
}

if ($resolvedPort -ne $requestedPort) {
  Write-Host "Porta $requestedPort em uso; usando fallback $resolvedPort."
}

$devUrl = "http://127.0.0.1:$resolvedPort"
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
  $baseDevCsp -replace "ws://127\\.0\\.0\\.1:\\d+", ("ws://127.0.0.1:{0}" -f $resolvedPort)
}

$runtimeConfig = [ordered]@{
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

$env:CODEX_DESKTOP_DEV_PORT = "$resolvedPort"
Write-Host "Iniciando dev em $devUrl"

try {
  & pnpm tauri dev --config $tempConfigPath
  $exitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempConfigPath -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
  throw "pnpm tauri dev falhou com código $exitCode."
}

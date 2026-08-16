[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$defaultPort = 1420
$requestedPort = $defaultPort
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$debugExecutablePath = Join-Path $projectRoot "src-tauri\target\debug\codex-desktop-next.exe"
. (Join-Path $PSScriptRoot "runtime-profile.ps1")
. (Join-Path $PSScriptRoot "project-tools.ps1")
Enable-ProjectTools -ProjectRoot $projectRoot | Out-Null

if ($env:CODEX_DESKTOP_DEV_PORT) {
  $portFromEnv = 0
  if (-not [int]::TryParse($env:CODEX_DESKTOP_DEV_PORT, [ref]$portFromEnv)) {
    throw "A variável CODEX_DESKTOP_DEV_PORT precisa ser um número inteiro entre 1 e 65535."
  }
  $requestedPort = $portFromEnv
} elseif ($env:VITE_PORT) {
  $portFromViteEnv = 0
  if (-not [int]::TryParse($env:VITE_PORT, [ref]$portFromViteEnv)) {
    throw "A variável VITE_PORT precisa ser um número inteiro entre 1 e 65535."
  }
  $requestedPort = $portFromViteEnv
}

if ($requestedPort -lt 1 -or $requestedPort -gt 65535) {
  throw "Porta inválida para desenvolvimento: $requestedPort. Use um valor entre 1 e 65535."
}

$existingDevProcesses = @(Get-ProcessesByExecutablePath -ExecutablePath $debugExecutablePath)
if ($existingDevProcesses.Count -gt 0) {
  $details = $existingDevProcesses | ForEach-Object {
    "pid=$($_.Pid) caminho=$($_.Path) comando=$($_.Command)"
  }
  throw @(
    "Já existe uma instância dev deste perfil em execução.",
    ($details -join "`n")
  ) -join "`n"
}

$listeners = @(Get-LoopbackListeners -Port $requestedPort)
if ($listeners.Count -gt 0) {
  $conflictProcessIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  $details = foreach ($processId in $conflictProcessIds) {
    $process = Get-ProcessDetails -ProcessId $processId
    "pid=$($process.Pid) caminho=$($process.Path) comando=$($process.Command)"
  }

  $killCommands = foreach ($processId in $conflictProcessIds) {
    "Stop-Process -Id $processId -Force"
  }

  $message = @(
    "A porta 127.0.0.1:$requestedPort já está em uso.",
    "Processos em conflito:",
    ($details -join "`n"),
    "Para liberar: $($killCommands -join ' ; ')"
  ) -join "`n"
  throw $message
}

$env:CODEX_DESKTOP_DEV_PORT = "$requestedPort"

if ($CheckOnly) {
  Write-Host "Sanidade concluída. Porta 127.0.0.1:$requestedPort disponível."
  exit 0
}

Write-Host "Iniciando Vite em 127.0.0.1:$requestedPort"
& pnpm dev:server
if ($LASTEXITCODE -ne 0) {
  throw "pnpm dev:server falhou com código $LASTEXITCODE."
}

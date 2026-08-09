[CmdletBinding()]
param(
  [Parameter()]
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$defaultPort = 1420
$requestedPort = $defaultPort

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

function Get-ProcessesListeningOnPort {
  param([int]$Port)

  try {
    return Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @("127.0.0.1", "::1", "localhost") }
  } catch {
    Write-Warning "Não foi possível consultar conexões TCP locais. Continue com cautela."
    return @()
  }
}

function Get-ProcessDetails {
  param([int]$ProcessId)

  $cimProcess = $null
  try {
    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  } catch {}

  if (-not $cimProcess) {
    try {
      $cimProcess = Get-WmiObject Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    } catch {}
  }

  $processObject = $null
  if ($cimProcess -and $cimProcess.ExecutablePath) {
    $commandLine = if ([string]::IsNullOrWhiteSpace($cimProcess.CommandLine)) {
      "<desconhecido>"
    } else {
      $cimProcess.CommandLine
    }
    return [PSCustomObject]@{
      Pid = $ProcessId
      Path = $cimProcess.ExecutablePath
      Command = $commandLine
    }
  }

  try {
    $processObject = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  } catch {}

  $path = if ($cimProcess.ExecutablePath) {
    $cimProcess.ExecutablePath
  } else {
    "<desconhecido>"
  }
  $command = if ($cimProcess.CommandLine) {
    $cimProcess.CommandLine
  } elseif ($processObject.ProcessName) {
    $processObject.ProcessName
  } else {
    "<desconhecido>"
  }
  if ($processObject) {
    if ($path -eq "<desconhecido>" -and $processObject.PSObject.Properties.Name -contains "Path" -and $processObject.Path) {
      $path = $processObject.Path
    }
    if ($path -eq "<desconhecido>" -and $processObject.PSObject.Properties.Name -contains "ProcessName" -and $processObject.ProcessName) {
      $path = $processObject.ProcessName
    }
  }

  return [PSCustomObject]@{
    Pid = $ProcessId
    Path = $path
    Command = $command
  }
}

$listeners = @(Get-ProcessesListeningOnPort -Port $requestedPort)
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
pnpm dev:server

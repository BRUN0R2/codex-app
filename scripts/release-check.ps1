[CmdletBinding()]
param(
  [Parameter()]
  [ValidateRange(1024, 65535)]
  [int]$DevPort = 1420,

  [Parameter()]
  [switch]$CheckOnly,

  [Parameter()]
  [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$exePath = Join-Path $projectRoot "src-tauri\target\release\codex-desktop-next.exe"
$appProcessName = "codex-desktop-next"

function Get-ProcessesListeningOnPort {
  param([int]$Port)

  try {
    return Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @("127.0.0.1", "::1", "localhost") }
  } catch {
    Write-Warning "Não foi possível consultar conexões TCP locais (possível limitação do ambiente)."
    return @()
  }
}

$existingProcesses = Get-Process -Name $appProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $exePath }

if ($existingProcesses) {
  $pids = ($existingProcesses | Select-Object -ExpandProperty Id) -join ", "
  throw "Fecha o aplicativo release atual antes de executar release:processos encontrados: $pids"
}

$listeners = Get-ProcessesListeningOnPort -Port $DevPort
if ($listeners) {
  $details = foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
      endereco = $listener.LocalAddress
      porta = $listener.LocalPort
      pid = $listener.OwningProcess
      comando = $process.CommandLine
      caminho = $process.ExecutablePath
    }
  }

  $detailsText = $details | ForEach-Object {
    "pid=$($_.pid) caminho=$($_.caminho) comando=$($_.comando)"
  }

  $message = @(
    "Detectei processos escutando em http://127.0.0.1:${DevPort}:",
    $detailsText -join "`n",
    "Isso normalmente indica o Vite de outro app em dev.",
    "Feche ou mova a porta desse processo antes de abrir o release."
  ) -join "`n"
  throw $message
}

if ($CheckOnly) {
  Write-Host "Sanidade concluída: sem conflitos de porta e sem instância release em execução."
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

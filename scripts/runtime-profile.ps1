Set-StrictMode -Version Latest

function Get-ProcessesByExecutablePath {
  param(
    [Parameter(Mandatory)]
    [string]$ExecutablePath
  )

  $targetPath = [System.IO.Path]::GetFullPath($ExecutablePath)
  $processName = [System.IO.Path]::GetFileName($targetPath)
  $records = @()

  try {
    $records = @(
      Get-CimInstance Win32_Process -Filter "Name='$processName'" -ErrorAction Stop |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
          [System.StringComparer]::OrdinalIgnoreCase.Equals(
            [System.IO.Path]::GetFullPath($_.ExecutablePath),
            $targetPath
          )
        } |
        ForEach-Object {
          [pscustomobject]@{
            Pid = [int]$_.ProcessId
            Path = $_.ExecutablePath
            Command = if ([string]::IsNullOrWhiteSpace($_.CommandLine)) {
              "<desconhecido>"
            } else {
              $_.CommandLine
            }
          }
        }
    )
  } catch {
    $records = @(
      Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($processName)) -ErrorAction SilentlyContinue |
        Where-Object {
          $_.PSObject.Properties.Name -contains "Path" -and
          -not [string]::IsNullOrWhiteSpace($_.Path) -and
          [System.StringComparer]::OrdinalIgnoreCase.Equals(
            [System.IO.Path]::GetFullPath($_.Path),
            $targetPath
          )
        } |
        ForEach-Object {
          [pscustomobject]@{
            Pid = [int]$_.Id
            Path = $_.Path
            Command = $_.ProcessName
          }
        }
    )
  }

  return $records
}

function Get-LoopbackListeners {
  param(
    [Parameter(Mandatory)]
    [ValidateRange(1, 65535)]
    [int]$Port
  )

  try {
    return @(
      Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object {
          $_.LocalPort -eq $Port -and
          $_.LocalAddress -in @("127.0.0.1", "::1", "localhost")
        }
    )
  } catch {
    throw "Não foi possível consultar as portas TCP locais: $($_.Exception.Message)"
  }
}

function Get-ProcessDetails {
  param(
    [Parameter(Mandatory)]
    [int]$ProcessId
  )

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if ($null -ne $process) {
      return [pscustomobject]@{
        Pid = $ProcessId
        Path = if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
          "<desconhecido>"
        } else {
          $process.ExecutablePath
        }
        Command = if ([string]::IsNullOrWhiteSpace($process.CommandLine)) {
          "<desconhecido>"
        } else {
          $process.CommandLine
        }
      }
    }
  } catch {}

  $fallback = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    Pid = $ProcessId
    Path = if (
      $null -ne $fallback -and
      $fallback.PSObject.Properties.Name -contains "Path" -and
      -not [string]::IsNullOrWhiteSpace($fallback.Path)
    ) {
      $fallback.Path
    } else {
      "<desconhecido>"
    }
    Command = if ($null -ne $fallback) { $fallback.ProcessName } else { "<desconhecido>" }
  }
}

@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

set "APP_NAME=Codex App"
set "INTERACTIVE=1"
set "EXIT_CODE=0"

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Não foi possível acessar o diretório do projeto.
  endlocal
  exit /b 1
)

if "%~1"=="" goto menu

set "INTERACTIVE=0"
if /i "%~1"=="debug" goto debug
if /i "%~1"=="dev" goto debug
if /i "%~1"=="release" goto release
if /i "%~1"=="build" goto release
if /i "%~1"=="help" goto usage
if /i "%~1"=="--help" goto usage
if /i "%~1"=="/?" goto usage

echo [ERRO] Opção desconhecida: %~1
echo.
set "EXIT_CODE=2"
goto usage

:menu
title %APP_NAME% - Launcher
cls
echo.
echo  ============================================================
echo    CODEX APP
echo    Launcher de desenvolvimento para Windows
echo  ============================================================
echo.
echo    [1] Iniciar em modo debug
echo    [2] Compilar e iniciar release
echo    [0] Sair
echo.
choice /c 120 /n /m "  Selecione uma opção: "

if errorlevel 3 goto shutdown
if errorlevel 2 goto release
if errorlevel 1 goto debug

:debug
call :preflight
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto result
)

title %APP_NAME% - Debug
echo.
echo [INFO] Iniciando ambiente de desenvolvimento...
echo.
call pnpm dev:launch
set "EXIT_CODE=%ERRORLEVEL%"
goto result

:release
call :preflight
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto result
)

title %APP_NAME% - Release
echo.
echo [INFO] Compilando e iniciando a versão release...
echo.
call pnpm release
set "EXIT_CODE=%ERRORLEVEL%"
goto result

:preflight
where.exe node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js não foi encontrado no PATH.
  exit /b 1
)

where.exe pnpm >nul 2>&1
if errorlevel 1 (
  echo [ERRO] pnpm não foi encontrado no PATH.
  exit /b 1
)

where.exe pwsh >nul 2>&1
if errorlevel 1 (
  echo [ERRO] PowerShell 7 não foi encontrado no PATH.
  exit /b 1
)

pwsh -NoLogo -NoProfile -NonInteractive -Command "if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [ERRO] O executável pwsh precisa ser PowerShell 7 ou superior.
  exit /b 1
)

where.exe cargo >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Rust/Cargo não foi encontrado no PATH.
  exit /b 1
)

if not exist "package.json" (
  echo [ERRO] package.json não foi encontrado no diretório do projeto.
  exit /b 1
)

if not exist "src-tauri\tauri.conf.json" (
  echo [ERRO] src-tauri\tauri.conf.json não foi encontrado.
  exit /b 1
)

if not exist "node_modules" (
  echo [ERRO] As dependências ainda não foram instaladas.
  echo        Execute: pnpm install --frozen-lockfile
  exit /b 1
)

exit /b 0

:result
echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Operação concluída com sucesso.
) else (
  echo [ERRO] A operação terminou com o código %EXIT_CODE%.
)

if "%INTERACTIVE%"=="1" (
  echo.
  echo Pressione qualquer tecla para voltar ao menu...
  pause >nul
  goto menu
)
goto shutdown

:usage
echo Uso: %~nx0 [comando]
echo.
echo Comandos:
echo   debug, dev       Inicia o aplicativo em modo debug.
echo   release, build   Compila e inicia a versão release.
echo   help             Exibe esta ajuda.
goto shutdown

:shutdown
popd >nul
endlocal & exit /b %EXIT_CODE%

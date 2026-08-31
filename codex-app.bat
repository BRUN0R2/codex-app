@echo off
setlocal EnableExtensions

set "EXIT_CODE=0"

cd /d "%~dp0"

if /i "%~1"=="debug" goto debug
if /i "%~1"=="dev" goto debug
if /i "%~1"=="release" goto release
if /i "%~1"=="build" goto release
if "%~1"=="" goto menu

echo Unknown command: %~1
set "EXIT_CODE=2"
goto result

:menu
cls
echo.
echo  Codex App
echo  ==============================
echo.
echo  1. Start in debug mode
echo  2. Build and start release
echo  0. Exit
echo.
choice /c 120 /n /m "Select an option: "

if errorlevel 3 goto end
if errorlevel 2 goto release
if errorlevel 1 goto debug

:debug
call :prepare_node_dependencies || goto failure
echo.
echo Starting Codex App in debug mode...
echo.
call pnpm dev:launch
set "EXIT_CODE=%ERRORLEVEL%"
goto result

:release
call :prepare_node_dependencies || goto failure
echo.
echo Building and starting Codex App release...
echo.
call pnpm release
set "EXIT_CODE=%ERRORLEVEL%"
goto result

:prepare_node_dependencies
call :require_pnpm || exit /b 1

if not exist "pnpm-lock.yaml" (
  echo pnpm-lock.yaml was not found. Dependencies cannot be installed reproducibly.
  exit /b 1
)

if not exist "node_modules" goto install_node_dependencies

call pnpm list --depth=0 >nul 2>nul
if errorlevel 1 goto install_node_dependencies

if not exist "node_modules\.bin\tauri.cmd" goto rebuild_node_shims
goto node_dependencies_ready

:install_node_dependencies
echo.
echo Local dependencies are missing or inconsistent.
echo Installing the exact versions defined in pnpm-lock.yaml...
echo.
call pnpm install --frozen-lockfile
if errorlevel 1 (
  echo.
  echo Dependency installation failed.
  exit /b 1
)

call pnpm list --depth=0 >nul 2>nul
if errorlevel 1 (
  echo The dependency tree remained inconsistent after installation.
  exit /b 1
)

if exist "node_modules\.bin\tauri.cmd" goto node_dependencies_ready

:rebuild_node_shims
echo.
echo Recreating local dependency commands...
echo.
call pnpm rebuild
if errorlevel 1 (
  echo.
  echo Recreating local dependency commands failed.
  exit /b 1
)

:node_dependencies_ready
if not exist "node_modules\.bin\tauri.cmd" (
  echo The local Tauri CLI was not found after dependency preparation.
  exit /b 1
)

exit /b 0

:require_pnpm
where pnpm.cmd >nul 2>nul
if not errorlevel 1 exit /b 0

where pnpm.exe >nul 2>nul
if not errorlevel 1 exit /b 0

echo pnpm was not found on PATH.
echo Install pnpm 11.22.0 and make the command available on PATH.
exit /b 1

:failure
set "EXIT_CODE=1"
echo.
echo Unable to start the operation.

:result
echo.
if "%EXIT_CODE%"=="0" (
  echo Operation completed.
) else (
  echo The operation exited with code %EXIT_CODE%.
)

if "%~1"=="" (
  echo.
  pause
)

:end
endlocal & exit /b %EXIT_CODE%

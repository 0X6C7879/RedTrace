@echo off
rem RedTrace one-click launcher (Windows).
rem
rem Boots the whole system with a single command: the RedTrace API server
rem plus, when provider Workers are configured, the long-lived DSH Cordis
rem runtime that schedules them. Prerequisites are checked and bootstrapped
rem in order:
rem
rem   1. uv (Python environment)          3. DSH vendored runtime tree
rem   2. Node.js >= 22.19 (DSH runtime)   4. DSH install + build (first run)
rem
rem Configuration lives in redtrace.yaml at the repository root; see
rem redtrace.dsh.example.yaml for the worker-centric providers format.
rem Extra arguments pass through to `redtrace start` (e.g. --port 8001).

setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PROJECT=%ROOT%\redtrace"

rem -- 1. Python environment (uv) -----------------------------------------
where uv >nul 2>nul || (
  echo error: uv is not installed or not on PATH 1>&2
  echo   install: https://docs.astral.sh/uv/getting-started/installation/ 1>&2
  exit /b 1
)
if not defined UV_PROJECT_ENVIRONMENT set "UV_PROJECT_ENVIRONMENT=%PROJECT%\.venv-windows"
if not exist "%UV_PROJECT_ENVIRONMENT%\Scripts\redtrace.exe" (
  echo ==^> preparing the Python environment ^(uv sync^) 1>&2
  uv sync --project "%PROJECT%" || exit /b 1
)

rem -- 2. Node.js (the DSH Cordis runtime needs ^>= 22.19) -----------------
where node >nul 2>nul || (
  echo error: Node.js ^>= 22.19 is required for the DSH runtime and was not found 1>&2
  echo   install: https://nodejs.org/ 1>&2
  exit /b 1
)
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=v." %%a in ('node --version') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if not defined NODE_MINOR set "NODE_MINOR=0"
if !NODE_MAJOR! LSS 22 goto :nodeTooOld
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! LSS 19 goto :nodeTooOld
goto :nodeOk

:nodeTooOld
for /f "delims=" %%v in ('node --version') do echo error: Node.js ^>= 22.19 is required for DSH; found %%v 1>&2
exit /b 1

:nodeOk

rem -- 3. DSH vendored runtime tree ----------------------------------------
if not exist "%ROOT%\vendor\deepseek-harness\package.json" (
  echo error: vendor\deepseek-harness is missing from the checkout 1>&2
  exit /b 1
)

rem -- 4. DSH install + build (first run only) -------------------------------
where npm >nul 2>nul || (
  echo error: npm is required for the DSH runtime and was not found 1>&2
  exit /b 1
)
if not exist "%ROOT%\vendor\deepseek-harness\packages\boot\app-boot\lib\index.js" (
  if not exist "%ROOT%\packages\redtrace-dsh\lib\index.js" (
    echo ==^> first run: installing and building DSH runtime 1>&2
    call "%ROOT%\build-dsh.cmd" || exit /b 1
  )
)

rem -- 5. Dispatcher configuration ----------------------------------------
rem --help is answered by `redtrace start` itself and needs no config file.
set "LAUNCHER_ARGS=%*"
if defined LAUNCHER_ARGS if not "!LAUNCHER_ARGS:--help=!"=="!LAUNCHER_ARGS!" (
  uv run --no-sync --project "%PROJECT%" redtrace start %*
  exit /b !errorlevel!
)
if not exist "%ROOT%\redtrace.yaml" (
  echo error: %ROOT%\redtrace.yaml not found 1>&2
  echo   copy redtrace.dsh.example.yaml to redtrace.yaml, fill in a provider 1>&2
  echo   api_key, and adjust the Workers - then start again 1>&2
  exit /b 1
)

uv run --no-sync --project "%PROJECT%" redtrace start %*
exit /b %errorlevel%

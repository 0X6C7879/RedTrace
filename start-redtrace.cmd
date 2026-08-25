@echo off
rem RedTrace one-click launcher (Windows).
rem
rem Boots the whole system with a single command: the RedTrace API server
rem plus, when provider Workers are configured, the long-lived DSH Cordis
rem runtime that schedules them. Prerequisites are checked and bootstrapped
rem in order:
rem
rem   1. uv (Python environment)          3. DSH git submodule
rem   2. Node.js >= 22.19 (DSH runtime)   4. DSH build artifacts (auto-built once)
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

rem -- 3. DSH submodule ---------------------------------------------------
if not exist "%ROOT%\vendor\deepseek-harness\package.json" (
  where git >nul 2>nul || (
    echo error: the DSH submodule is missing and git is unavailable to fetch it 1>&2
    exit /b 1
  )
  echo ==^> initializing the DSH submodule ^(first run^) 1>&2
  git -C "%ROOT%" submodule update --init --recursive || exit /b 1
)

rem -- 4. DSH build artifacts (built once; re-run with `npm run dsh:build`) -
if not exist "%ROOT%\packages\redtrace-dsh\lib\index.js" (
  goto :dshBuild
)
if not exist "%ROOT%\vendor\deepseek-harness\packages\boot\app-boot\lib\index.js" (
  goto :dshBuild
)
goto :dshBuilt

:dshBuild
where npm >nul 2>nul || (
  echo error: DSH build artifacts are missing and npm is unavailable to build them 1>&2
  exit /b 1
)
echo ==^> building the DSH runtime ^(first run; a few minutes^) 1>&2
pushd "%ROOT%" || exit /b 1
call npm run dsh:install || (popd & exit /b 1)
call npm run dsh:build || (popd & exit /b 1)
popd

:dshBuilt

rem -- 5. Dispatcher configuration ----------------------------------------
if not exist "%ROOT%\redtrace.yaml" (
  echo error: %ROOT%\redtrace.yaml not found 1>&2
  echo   copy redtrace.dsh.example.yaml to redtrace.yaml, fill in a provider 1>&2
  echo   api_key, and adjust the Workers - then start again 1>&2
  exit /b 1
)

uv run --no-sync --project "%PROJECT%" redtrace start %*
exit /b %errorlevel%

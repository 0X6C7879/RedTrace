@echo off
rem RedTrace DSH build script (Windows).
rem
rem Installs DSH dependencies and compiles all artifacts.
rem Run this once after cloning, and again after pulling upstream changes.
rem
rem   build-dsh.cmd          full install + build
rem   build-dsh.cmd --rebuild  delete node_modules and reinstall before building

setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node >nul 2>nul || (
  echo error: Node.js ^>= 22.19 is required 1>&2
  exit /b 1
)
where npm >nul 2>nul || (
  echo error: npm is required 1>&2
  exit /b 1
)

pushd "%ROOT%" || exit /b 1

rem -- Install dependencies if missing or --rebuild requested ---------------
set "REBUILD=0"
if "%~1"=="--rebuild" set "REBUILD=1"
if not exist "%ROOT%\vendor\deepseek-harness\node_modules\.bin\tsx.cmd" set "REBUILD=1"
if "!REBUILD!"=="1" (
  echo ==^> installing DSH dependencies 1>&2
  if exist "%ROOT%\vendor\deepseek-harness\node_modules" (
    rmdir /s /q "%ROOT%\vendor\deepseek-harness\node_modules"
  )
  node scripts/dsh-pnpm.mjs install --frozen-lockfile || (popd & exit /b 1)
)

rem -- Build ----------------------------------------------------------------
echo ==^> building DSH runtime 1>&2
call npm run dsh:build || (popd & exit /b 1)
popd

echo ==^> build complete 1>&2

@echo off
rem RedTrace Node launcher (Windows). Node 24.15+ is the only runtime required.
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem Prefer the repository-pinned runtime used by this checkout when present.
if exist "%ROOT%\.redtrace\tools\node-v24.21.0-win-x64\node.exe" set "PATH=%ROOT%\.redtrace\tools\node-v24.21.0-win-x64;%PATH%"
where node >nul 2>nul || (
  echo error: Node.js 24.15 or newer from the Node 24 line is required 1>&2
  echo   install: https://nodejs.org/ 1>&2
  exit /b 1
)
for /f "tokens=1,2,3 delims=v." %%a in ('node --version') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
  set "NODE_PATCH=%%c"
)
if not "!NODE_MAJOR!"=="24" goto :nodeUnsupported
if !NODE_MINOR! LSS 15 goto :nodeUnsupported
goto :nodeOk

:nodeUnsupported
for /f "delims=" %%v in ('node --version') do echo error: Node.js 24.15+ ^(^<25^) is required; found %%v 1>&2
exit /b 1

:nodeOk
where npm >nul 2>nul || (
  echo error: npm is required to install the Node runtime dependencies 1>&2
  exit /b 1
)
if not exist "%ROOT%\packages\redtrace-engine\node_modules\yaml\package.json" (
  echo ==^> first run: installing RedTrace Node dependencies 1>&2
  call npm ci --prefix "%ROOT%\packages\redtrace-engine" || exit /b 1
)
if not exist "%ROOT%\vendor\deepseek-harness\package.json" (
  echo error: vendor\deepseek-harness is missing from the checkout 1>&2
  exit /b 1
)
if not exist "%ROOT%\vendor\deepseek-harness\packages\boot\app-boot\lib\index.js" goto :buildDsh
if not exist "%ROOT%\packages\redtrace-dsh\lib\index.js" goto :buildDsh
goto :run

:buildDsh
echo ==^> first run: installing and building the Cordis compatibility runtime 1>&2
call "%ROOT%\build-dsh.cmd" || exit /b 1

:run
node "%ROOT%\scripts\run-redtrace-node.mjs" --compat --root "%ROOT%" %*
exit /b %errorlevel%

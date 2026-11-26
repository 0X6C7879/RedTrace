@echo off
rem RedTrace Node launcher (Windows). Node 24.11+ or 26+ is required.
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem Prefer a compatible system Node; use the bundled Node 24 runtime only as fallback.
set "BUNDLED_NODE=%ROOT%\.redtrace\tools\node-v24.21.0-win-x64"
call :checkNode
if "!NODE_SUPPORTED!"=="1" goto :nodeOk
if exist "%BUNDLED_NODE%\node.exe" (
  set "PATH=%BUNDLED_NODE%;%PATH%"
  call :checkNode
  if "!NODE_SUPPORTED!"=="1" goto :nodeOk
)
:nodeUnsupported
set "NODE_FOUND=none"
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_FOUND=%%v"
echo error: Node.js 24.11+ or 26+ is required; found !NODE_FOUND! 1>&2
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
rem Rebuild when the adapter sources are newer than the compiled lib; stale lib
rem output crashes startup at import time (same as a missing build).
powershell -NoProfile -Command "$lib=(Get-Item '%ROOT%\packages\redtrace-dsh\lib\index.js').LastWriteTime; if (Get-ChildItem -Recurse '%ROOT%\packages\redtrace-dsh\src' -Filter *.ts | Where-Object {$_.LastWriteTime -gt $lib} | Select-Object -First 1) { exit 0 }; exit 1" >nul 2>nul
if not errorlevel 1 goto :buildDsh
goto :run

:buildDsh
echo ==^> first run: installing and building the Cordis compatibility runtime 1>&2
call "%ROOT%\build-dsh.cmd" || exit /b 1

:run
node "%ROOT%\scripts\run-redtrace-node.mjs" --root "%ROOT%" %*
exit /b %errorlevel%

:checkNode
set "NODE_SUPPORTED=0"
where node >nul 2>nul || exit /b 0
for /f "tokens=1,2,3 delims=v." %%a in ('node --version') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if !NODE_MAJOR! GTR 25 set "NODE_SUPPORTED=1"
if !NODE_MAJOR! EQU 24 if !NODE_MINOR! GEQ 11 set "NODE_SUPPORTED=1"
exit /b 0

@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================================
:: RedTrace Security Tools Installer (Windows)
:: Supports: Native CMD (choco/scoop) · Git Bash · WSL
::
:: Usage:
::   install-tools.cmd              Install everything
::   install-tools.cmd --check      Only check what's installed
::   install-tools.cmd --system     Only install system packages
::   install-tools.cmd --python     Only install Python packages
::   install-tools.cmd --assets     Only download wordlists/payloads/PoC
::   install-tools.cmd --binaries   Only download portable binaries
::   install-tools.cmd --help       Show help
:: ============================================================================

set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "TOOLS_DIR=%SCRIPT_DIR%\tools"
set "BIN_DIR=%TOOLS_DIR%\bin"
set "WORDLISTS_DIR=%TOOLS_DIR%\wordlists"
set "PAYLOADS_DIR=%TOOLS_DIR%\payloads"
set "POC_DIR=%TOOLS_DIR%\poc"
set "REQUIREMENTS_FILE=%SCRIPT_DIR%\requirements.txt"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=all"

:: ── Try Git Bash first (most compatible) ──────────────────────────────────
set "BASH_CMD="
where bash >nul 2>&1 && (
    for /f "delims=" %%i in ('where bash') do (
        if not defined BASH_CMD set "BASH_CMD=%%i"
    )
)
if defined BASH_CMD (
    if exist "%SCRIPT_DIR%\install-tools.sh" (
        echo [INFO] Found Git Bash, delegating to install-tools.sh ...
        "%BASH_CMD%" "%SCRIPT_DIR%\install-tools.sh" %*
        exit /b %errorlevel%
    )
)

:: ── Try WSL ───────────────────────────────────────────────────────────────
where wsl >nul 2>&1 && (
    echo [INFO] Found WSL, delegating to install-tools.sh via WSL ...
    wsl bash -c "cd '%SCRIPT_DIR%' && bash install-tools.sh %*"
    exit /b %errorlevel%
)

:: ── Native Windows mode ───────────────────────────────────────────────────
echo.
echo ==========================================
echo   RedTrace Security Tools Installer
echo   Platform: Windows (native CMD)
echo ==========================================
echo.

:: Detect package manager
set "PKG_MGR=none"
where choco >nul 2>&1 && set "PKG_MGR=choco"
if "%PKG_MGR%"=="none" where scoop >nul 2>&1 && set "PKG_MGR=scoop"
echo [INFO] Package manager: %PKG_MGR%

:: Detect proxy (common local proxy ports)
set "PROXY_URL="
for %%p in (7890 7891 1080 8080) do (
    if not defined PROXY_URL (
        powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %%p); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1 && (
            set "PROXY_URL=http://127.0.0.1:%%p"
        )
    )
)
if defined PROXY_URL (
    echo [INFO] Using proxy: %PROXY_URL%
)

:: Setup directories
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
if not exist "%WORDLISTS_DIR%" mkdir "%WORDLISTS_DIR%"
if not exist "%PAYLOADS_DIR%" mkdir "%PAYLOADS_DIR%"
if not exist "%POC_DIR%" mkdir "%POC_DIR%"

:: Route to mode
if /i "%MODE%"=="--check"    goto :check_all
if /i "%MODE%"=="--system"   goto :install_system
if /i "%MODE%"=="--python"   goto :install_python
if /i "%MODE%"=="--assets"   goto :install_assets
if /i "%MODE%"=="--binaries" goto :install_binaries
if /i "%MODE%"=="--help"     goto :show_help
if /i "%MODE%"=="-h"         goto :show_help
if /i "%MODE%"=="all"        goto :install_all

echo [ERR] Unknown option: %MODE%
goto :show_help

:: ============================================================================
:show_help
echo RedTrace Security Tools Installer (Windows)
echo.
echo Usage: %~nx0 [OPTIONS]
echo.
echo Options:
echo   (none)       Install everything
echo   --check      Check what is installed
echo   --system     Install system packages only
echo   --python     Install Python packages only
echo   --assets     Download wordlists/payloads/PoC repos only
echo   --binaries   Download portable binaries only
echo   --help       Show this help
echo.
echo Note: If Git Bash or WSL is available, this script will automatically
echo       delegate to install-tools.sh for full Linux/macOS tool coverage.
echo.
goto :eof

:: ============================================================================
:install_all
call :install_system
call :install_python
call :install_binaries
call :install_assets
call :post_install
goto :eof

:: ============================================================================
:: CHECK MODE
:: ============================================================================
:check_all
set FOUND=0
set MISSING=0

echo.
echo -- Core System Tools --
for %%t in (bash curl wget git jq openssl) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Compression --
for %%t in (tar gzip zip unzip 7z) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Network Tools --
for %%t in (ping nslookup tracert socat ncat) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Scanning ^& Discovery --
for %%t in (nmap masscan rustscan fping) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Web / HTTP Testing --
for %%t in (httpx nikto ffuf gobuster feroxbuster nuclei sqlmap) do (
    call :_check_cmd "%%t"
)
:: Tools that may be in non-standard locations
for %%t in (whatweb dirsearch dirb) do (
    call :_check_cmd_extra "%%t"
)
echo.
echo -- Brute Force / Auth --
for %%t in (hydra medusa john hashcat sshpass) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Tunneling / Pivot --
for %%t in (proxychains chisel) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Packet Analysis --
for %%t in (tshark tcpdump windump) do (
    call :_check_cmd "%%t"
)
echo.
echo -- RE / Binary --
for %%t in (radare2 rizin binwalk objdump checksec ROPgadget ropper) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Database Clients --
for %%t in (sqlite3 mysql psql redis-cli) do (
    call :_check_cmd "%%t"
)
echo.
echo -- OCR / Image --
for %%t in (tesseract magick exiftool) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Encoding / Hash --
for %%t in (openssl certutil) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Language Runtimes --
for %%t in (python3 python node go java php) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Data Processing --
for %%t in (jq) do (
    call :_check_cmd "%%t"
)
echo.
echo -- Assets in tools\ --
if exist "%WORDLISTS_DIR%\SecLists\*" (
    echo [OK]    SecLists
    set /a FOUND+=1
) else (
    echo [WARN]  SecLists - NOT FOUND
    set /a MISSING+=1
)
if exist "%PAYLOADS_DIR%\PayloadsAllTheThings\*" (
    echo [OK]    PayloadsAllTheThings
    set /a FOUND+=1
) else (
    echo [WARN]  PayloadsAllTheThings - NOT FOUND
    set /a MISSING+=1
)
dir /b "%BIN_DIR%\chisel*" 2>nul | findstr /n "." >nul 2>&1
if !errorlevel! equ 0 (
    echo [OK]    Chisel binaries
    set /a FOUND+=1
) else (
    echo [WARN]  Chisel binaries - NOT FOUND
    set /a MISSING+=1
)
dir /b "%BIN_DIR%\ligolo*" 2>nul | findstr /n "." >nul 2>&1
if !errorlevel! equ 0 (
    echo [OK]    Ligolo-ng binaries
    set /a FOUND+=1
) else (
    echo [WARN]  Ligolo-ng binaries - NOT FOUND
    set /a MISSING+=1
)

echo.
echo ==========================================
echo   Found: %FOUND%  ^|  Missing: %MISSING%
echo ==========================================
echo.
goto :eof

:_check_cmd
set "_name=%~1"
where %_name% >nul 2>&1 && (
    echo [OK]    %_name%
    set /a FOUND+=1
) || (
    echo [WARN]  %_name% - NOT FOUND
    set /a MISSING+=1
)
goto :eof

:_check_cmd_extra
set "_name=%~1"
where %_name% >nul 2>&1 && (
    echo [OK]    %_name%
    set /a FOUND+=1
) || (
    if exist "%USERPROFILE%\local\bin\%_name%" (
        echo [OK]    %_name% (%%USERPROFILE%%\local\bin)
        set /a FOUND+=1
    ) else (
        if exist "%USERPROFILE%\.local\bin\%_name%" (
            echo [OK]    %_name% (%%USERPROFILE%%\.local\bin)
            set /a FOUND+=1
        ) else (
            echo [WARN]  %_name% - NOT FOUND
            set /a MISSING+=1
        )
    )
)
goto :eof

:: ============================================================================
:: SYSTEM PACKAGES
:: ============================================================================
:install_system
echo.
echo [INFO] Installing system packages via %PKG_MGR% ...
echo.

if "%PKG_MGR%"=="none" (
    echo [ERR]  No package manager found. Install Chocolatey or Scoop first.
    echo [INFO]   Chocolatey: https://chocolatey.org/install
    echo [INFO]   Scoop:      https://scoop.sh
    goto :eof
)

:: ── Core System ──
echo -- Core System --
call :_install_pkg jq
call :_install_pkg xmlstarlet xmlstarlet xmlstarlet

:: ── Network ──
echo -- Network Tools --
call :_install_pkg nmap
call :_install_pkg socat
call :_install_pkg openssl openssl openssl

:: ── Scanning ^& Discovery ──
echo -- Scanning ^& Discovery --
call :_install_pkg nmap
call :_install_pkg masscan
call :_install_pkg rustscan

:: ── Web / HTTP ──
echo -- Web / HTTP Testing --
call :_install_pkg nikto
call :_install_pkg ffuf
call :_install_pkg gobuster
call :_install_pkg feroxbuster
call :_install_pkg nuclei
call :_install_pkg sqlmap
call :_install_pkg httpx

:: dirsearch via pipx
where dirsearch >nul 2>&1 || (
    where pipx >nul 2>&1 && (
        echo [>>]   Installing dirsearch via pipx ...
        pipx install dirsearch >nul 2>&1 && echo [OK]    dirsearch ^(pipx^) || echo [WARN]  dirsearch pipx install failed
    )
)

:: ── Brute Force / Auth ──
echo -- Brute Force / Auth --
call :_install_pkg hydra
call :_install_pkg john
call :_install_pkg hashcat

:: ── Packet Analysis ──
echo -- Packet Analysis --
call :_install_pkg wireshark wireshark wireshark
call :_install_pkg winpcap winpcap winpcap

:: ── RE / Binary ──
echo -- RE / Binary --
call :_install_pkg radare2
call :_install_pkg rizin
call :_install_pkg binwalk

:: ropper via uv/pipx
where ropper >nul 2>&1 || (
    where uv >nul 2>&1 && (
        echo [>>]   Installing ropper via uv ...
        uv tool install ropper --python 3.12 >nul 2>&1 && echo [OK]    ropper ^(uv^) || echo [WARN]  ropper uv install failed
    )
)

:: ── Database Clients ──
echo -- Database Clients --
call :_install_pkg sqlite sqlite sqlite
call :_install_pkg mysql mysql mysql
call :_install_pkg psql postgresql postgresql

:: ── OCR / Image ──
echo -- OCR / Image --
call :_install_pkg tesseract
call :_install_pkg imagemagick imagemagick imagemagick
call :_install_pkg exiftool exiftool exiftool

:: ── Language Runtimes ──
echo -- Language Runtimes --
call :_install_pkg python3 python python3
call :_install_pkg node nodejs nodejs
call :_install_pkg go golang golang
call :_install_pkg java openjdk openjdk

:: ── Proxy Tools ──
echo -- Proxy Tools --
call :_install_pkg proxychains-ng proxychains-ng proxychains-ng

echo.
echo [OK] System packages done.
echo.
goto :eof

:_install_pkg
set "_cmd=%~1"
set "_choco=%~2"
set "_scoop=%~3"
if "%_choco%"=="" set "_choco=%_cmd%"
if "%_scoop%"=="" set "_scoop=%_cmd%"

:: Skip if already installed
where %_cmd% >nul 2>&1 && (
    echo [SKIP]  %_cmd% already installed
    goto :eof
)

echo [>>]   Installing %_cmd% ...
if "%PKG_MGR%"=="choco" (
    choco install -y %_choco% >nul 2>&1 && echo [OK]    %_cmd% installed || echo [WARN]  %_cmd% install failed
) else if "%PKG_MGR%"=="scoop" (
    scoop install %_scoop% >nul 2>&1 && echo [OK]    %_cmd% installed || echo [WARN]  %_cmd% install failed
)
goto :eof

:: ============================================================================
:: PYTHON PACKAGES
:: ============================================================================
:install_python
echo.
echo [INFO] Installing Python packages ...
echo.

:: Find python
set "PY_CMD="
where python3 >nul 2>&1 && set "PY_CMD=python3"
if not defined PY_CMD where python >nul 2>&1 && set "PY_CMD=python"
if not defined PY_CMD (
    echo [ERR]  Python not found. Install Python first.
    goto :eof
)

:: Find pip
set "PIP_CMD="
where pip3 >nul 2>&1 && set "PIP_CMD=pip3"
if not defined PIP_CMD where pip >nul 2>&1 && set "PIP_CMD=pip"
if not defined PIP_CMD (
    %PY_CMD% -m pip --version >nul 2>&1 && set "PIP_CMD=%PY_CMD% -m pip"
)
if not defined PIP_CMD (
    echo [ERR]  pip not found. Install pip first.
    goto :eof
)

if not exist "%REQUIREMENTS_FILE%" (
    echo [ERR]  requirements.txt not found at %REQUIREMENTS_FILE%
    goto :eof
)

echo [>>]   Installing from requirements.txt ...
%PIP_CMD% install --user --upgrade -r "%REQUIREMENTS_FILE%" >nul 2>&1
if !errorlevel! equ 0 (
    echo [OK]    Python packages installed
) else (
    :: Try without --user (e.g. in a venv)
    %PIP_CMD% install --upgrade -r "%REQUIREMENTS_FILE%" >nul 2>&1
    if !errorlevel! equ 0 (
        echo [OK]    Python packages installed
    ) else (
        echo [WARN]  Some Python packages may have failed
    )
)

:: Playwright
%PY_CMD% -c "import playwright" >nul 2>&1 && (
    echo [>>]   Installing Playwright Chromium ...
    %PY_CMD% -m playwright install chromium 2>&1
)

:: Pwntools / z3-solver via uv (isolated from system Python)
where uv >nul 2>&1 (
    where pwn >nul 2>&1 || (
        echo [>>]   Installing pwntools via uv ...
        uv tool install pwntools --python 3.12 >nul 2>&1 && echo [OK]    pwntools ^(uv^) || echo [WARN]  pwntools install failed
    )
    where z3 >nul 2>&1 || (
        echo [>>]   Installing z3-solver via uv ...
        uv tool install z3-solver --python 3.12 >nul 2>&1 && echo [OK]    z3-solver ^(uv^) || echo [WARN]  z3-solver install failed
    )
)

echo.
echo [OK] Python packages done.
echo.
goto :eof

:: ============================================================================
:: PORTABLE BINARIES
:: ============================================================================
:install_binaries
echo.
echo [INFO] Installing portable binaries to %BIN_DIR% ...
echo.

:: Use PowerShell for downloads (built into all modern Windows)
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"

:: ── Chisel ──
set "CHISEL_VER=1.12.0"
set "CHISEL_BASE=https://github.com/jpillora/chisel/releases/download/v%CHISEL_VER%"

:: Current platform (amd64)
if not exist "%BIN_DIR%\chisel.exe" (
    echo [>>]   Downloading Chisel %CHISEL_VER% ^(windows_amd64^) ...
    set "TMPZIP=%TEMP%\chisel_win_$$.zip"
    %PS% "$p='%PROXY_URL%'; $u='%CHISEL_BASE%/chisel_%CHISEL_VER%_windows_amd64.zip'; $d='%TEMP%\chisel_dl.zip'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); Expand-Archive -Path $d -DestinationPath '%BIN_DIR%' -Force; Move-Item '%BIN_DIR%\chisel.exe' '%BIN_DIR%\chisel.exe' -Force; Remove-Item $d" >nul 2>&1
    if exist "%BIN_DIR%\chisel.exe" (
        echo [OK]    Chisel
    ) else (
        echo [WARN]  Chisel download failed
    )
) else (
    echo [SKIP]  Chisel already installed
)

:: All variants
for %%v in (linux_amd64 linux_arm64 linux_386 darwin_amd64 darwin_arm64) do (
    if not exist "%BIN_DIR%\chisel_%%v" (
        echo [>>]   Downloading Chisel for %%v ...
        %PS% "$p='%PROXY_URL%'; $u='%CHISEL_BASE%/chisel_%CHISEL_VER%_%%v.gz'; $d='%TEMP%\chisel_%%v.gz'; $o='%BIN_DIR%\chisel_%%v'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); $gs=New-Object IO.Compression.GZipStream([IO.File]::OpenRead($d),[IO.Compression.CompressionMode]::Decompress); $fs=[IO.File]::Create($o); $gs.CopyTo($fs); $fs.Close();$gs.Close();Remove-Item $d" >nul 2>&1
        if exist "%BIN_DIR%\chisel_%%v" (echo [OK]    chisel_%%v) else (echo [WARN]  chisel_%%v download failed)
    ) else (
        echo [SKIP]  chisel_%%v already exists
    )
)

:: Windows variants
for %%v in (windows_amd64 windows_386 windows_arm64) do (
    if not exist "%BIN_DIR%\chisel_%%v.exe" (
        echo [>>]   Downloading Chisel for %%v ...
        %PS% "$p='%PROXY_URL%'; $u='%CHISEL_BASE%/chisel_%CHISEL_VER%_%%v.zip'; $d='%TEMP%\chisel_%%v.zip'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); Expand-Archive -Path $d -DestinationPath '%TEMP%\chisel_%%v' -Force; Move-Item '%TEMP%\chisel_%%v\chisel.exe' '%BIN_DIR%\chisel_%%v.exe' -Force; Remove-Item $d; Remove-Item '%TEMP%\chisel_%%v' -Recurse -Force" >nul 2>&1
        if exist "%BIN_DIR%\chisel_%%v.exe" (echo [OK]    chisel_%%v.exe) else (echo [WARN]  chisel_%%v download failed)
    ) else (
        echo [SKIP]  chisel_%%v.exe already exists
    )
)

:: ── Ligolo-ng ──
set "LIGOLO_VER=0.9.1"
set "LIGOLO_BASE=https://github.com/nicocha30/ligolo-ng/releases/download/v%LIGOLO_VER%"

:: Proxy binaries (local)
for %%v in (linux_amd64 linux_arm64 darwin_amd64 darwin_arm64) do (
    if not exist "%BIN_DIR%\ligolo-ng_proxy_%%v" (
        echo [>>]   Downloading Ligolo-ng proxy for %%v ...
        %PS% "$p='%PROXY_URL%'; $u='%LIGOLO_BASE%/ligolo-ng_proxy_%LIGOLO_VER%_%%v.tar.gz'; $d='%TEMP%\ligolo_p_%%v.tar.gz'; $o='%BIN_DIR%\ligolo-ng_proxy_%%v'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); $td='%TEMP%\ligolo_p_%%v'; New-Item -ItemType Directory -Force -Path $td | Out-Null; tar xzf $d -C $td 2>$null; Copy-Item '$td\proxy' $o -Force; Remove-Item $d; Remove-Item $td -Recurse -Force" >nul 2>&1
        if exist "%BIN_DIR%\ligolo-ng_proxy_%%v" (echo [OK]    ligolo-ng_proxy_%%v) else (echo [WARN]  ligolo-ng_proxy_%%v download failed)
    ) else (
        echo [SKIP]  ligolo-ng_proxy_%%v already exists
    )
)

:: Agent binaries (for target machines)
for %%v in (linux_amd64 linux_arm64 linux_armv6 linux_armv7) do (
    if not exist "%BIN_DIR%\ligolo-ng_agent_%%v" (
        echo [>>]   Downloading Ligolo-ng agent for %%v ...
        %PS% "$p='%PROXY_URL%'; $u='%LIGOLO_BASE%/ligolo-ng_agent_%LIGOLO_VER%_%%v.tar.gz'; $d='%TEMP%\ligolo_a_%%v.tar.gz'; $o='%BIN_DIR%\ligolo-ng_agent_%%v'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); $td='%TEMP%\ligolo_a_%%v'; New-Item -ItemType Directory -Force -Path $td | Out-Null; tar xzf $d -C $td 2>$null; Copy-Item '$td\agent' $o -Force; Remove-Item $d; Remove-Item $td -Recurse -Force" >nul 2>&1
        if exist "%BIN_DIR%\ligolo-ng_agent_%%v" (echo [OK]    ligolo-ng_agent_%%v) else (echo [WARN]  ligolo-ng_agent_%%v download failed)
    ) else (
        echo [SKIP]  ligolo-ng_agent_%%v already exists
    )
)

:: Windows agent
if not exist "%BIN_DIR%\ligolo-ng_agent_windows_amd64.exe" (
    echo [>>]   Downloading Ligolo-ng agent for windows_amd64 ...
    %PS% "$p='%PROXY_URL%'; $u='%LIGOLO_BASE%/ligolo-ng_agent_%LIGOLO_VER%_windows_amd64.zip'; $d='%TEMP%\ligolo_aw.zip'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,$d); $td='%TEMP%\ligolo_aw'; Expand-Archive -Path $d -DestinationPath $td -Force; Copy-Item '$td\agent.exe' '%BIN_DIR%\ligolo-ng_agent_windows_amd64.exe' -Force; Remove-Item $d; Remove-Item $td -Recurse -Force" >nul 2>&1
    if exist "%BIN_DIR%\ligolo-ng_agent_windows_amd64.exe" (echo [OK]    ligolo-ng_agent_windows_amd64.exe) else (echo [WARN]  Ligolo-ng windows agent download failed)
) else (
    echo [SKIP]  ligolo-ng_agent_windows_amd64.exe already exists
)

:: ── plink ──
if not exist "%BIN_DIR%\plink.exe" (
    echo [>>]   Downloading plink.exe ...
    %PS% "$p='%PROXY_URL%'; $u='https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe'; $wc=New-Object Net.WebClient; if($p){$wc.Proxy=New-Object Net.WebProxy($p)}; $wc.DownloadFile($u,'%BIN_DIR%\plink.exe')" >nul 2>&1
    if exist "%BIN_DIR%\plink.exe" (echo [OK]    plink.exe) else (echo [WARN]  plink download failed)
) else (
    echo [SKIP]  plink.exe already exists
)

echo.
echo [OK] Portable binaries done.
echo.
goto :eof

:: ============================================================================
:: ASSETS — Wordlists, Payloads, PoC repos
:: ============================================================================
:install_assets
echo.
echo [INFO] Downloading wordlists, payloads, and PoC collections ...
echo.

:: Build git proxy args if proxy detected
set "GIT_PROXY="
if defined PROXY_URL (
    set "GIT_PROXY=-c http.proxy=%PROXY_URL% -c https.proxy=%PROXY_URL%"
)

:: ── SecLists ──
if exist "%WORDLISTS_DIR%\SecLists\.git" (
    echo [SKIP]  SecLists already exists
) else (
    echo [>>]   Cloning SecLists ^(large repo^) ...
    git %GIT_PROXY% clone --depth 1 https://github.com/danielmiessler/SecLists.git "%WORDLISTS_DIR%\SecLists" >nul 2>&1
    if !errorlevel! equ 0 (echo [OK]    SecLists) else (echo [WARN]  SecLists clone failed)
)

:: ── PayloadsAllTheThings ──
if exist "%PAYLOADS_DIR%\PayloadsAllTheThings\.git" (
    echo [SKIP]  PayloadsAllTheThings already exists
) else (
    echo [>>]   Cloning PayloadsAllTheThings ...
    git %GIT_PROXY% clone --depth 1 https://github.com/swisskyrepo/PayloadsAllTheThings.git "%PAYLOADS_DIR%\PayloadsAllTheThings" >nul 2>&1
    if !errorlevel! equ 0 (echo [OK]    PayloadsAllTheThings) else (echo [WARN]  PayloadsAllTheThings clone failed)
)

:: ── Nuclei Templates ──
where nuclei >nul 2>&1 && (
    if not exist "%WORDLISTS_DIR%\nuclei-templates\*" (
        echo [>>]   Downloading nuclei-templates ...
        nuclei -update-templates >nul 2>&1
        if exist "%USERPROFILE%\.nuclei-templates" (
            mklink /D "%WORDLISTS_DIR%\nuclei-templates" "%USERPROFILE%\.nuclei-templates" >nul 2>&1
            echo [OK]    nuclei-templates
        )
    ) else (
        echo [SKIP]  nuclei-templates already exists
    )
)

:: ── Vulhub ──
if exist "%POC_DIR%\vulhub\.git" (
    echo [SKIP]  Vulhub already exists
) else (
    echo [>>]   Cloning Vulhub PoC collection ...
    git %GIT_PROXY% clone --depth 1 https://github.com/vulhub/vulhub.git "%POC_DIR%\vulhub" >nul 2>&1
    if !errorlevel! equ 0 (echo [OK]    Vulhub) else (echo [WARN]  Vulhub clone failed)
)

:: ── Pwntools tutorial ──
if exist "%POC_DIR%\pwntools-tutorial\.git" (
    echo [SKIP]  Pwntools tutorial already exists
) else (
    echo [>>]   Cloning Pwntools tutorial ...
    git %GIT_PROXY% clone --depth 1 https://github.com/Gallopsled/pwntools-tutorial.git "%POC_DIR%\pwntools-tutorial" >nul 2>&1
    if !errorlevel! equ 0 (echo [OK]    Pwntools tutorial) else (echo [WARN]  Pwntools tutorial clone failed)
)

echo.
echo [OK] Assets done.
echo.
goto :eof

:: ============================================================================
:: POST-INSTALL
:: ============================================================================
:post_install
echo.
echo ==========================================
echo   RedTrace Tools Installation Complete
echo ==========================================
echo.
echo   Directory layout:
echo     tools\bin\          Portable binaries (chisel, ligolo-ng, plink)
echo     tools\wordlists\    SecLists, nuclei-templates
echo     tools\payloads\     PayloadsAllTheThings
echo     tools\poc\          Vulhub PoC, pwntools tutorial
echo.
echo   Add to PATH:
echo     setx PATH "%%PATH%%;%BIN_DIR%"
echo.
echo   Run '%~nx0 --check' to verify installation.
echo.
goto :eof

#!/usr/bin/env pwsh
# RedTrace local-mode bootstrap for Windows.
# Run as the same user that should own and reuse Claude/Codex/Pi login state.
#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:ConfigPath = if ($env:REDTRACE_CONFIG_PATH) { $env:REDTRACE_CONFIG_PATH } else { Join-Path $Script:ProjectDir 'redtrace.yaml' }
$Script:RunDir = Join-Path $Script:ProjectDir '.redtrace\run'
$Script:LogDir = Join-Path $Script:ProjectDir '.redtrace\log'
$Script:TmpDir = Join-Path $Script:ProjectDir '.redtrace\tmp'
$Script:RuntimeDir = Join-Path $Script:ProjectDir '.redtrace\runtime'
$Script:BinDir = Join-Path $Script:RuntimeDir 'bin'
$Script:LibDir = Join-Path $Script:RuntimeDir 'lib'
$Script:ToolVenv = if ($env:REDTRACE_TOOL_VENV) { $env:REDTRACE_TOOL_VENV } else { Join-Path $Script:ProjectDir '.redtrace\runtime\tools' }
$Script:NpmRegistry = if ($env:NPM_CONFIG_REGISTRY) { $env:NPM_CONFIG_REGISTRY } else { 'https://registry.npmmirror.com' }
$Script:PyPIIndex = if ($env:UV_INDEX_URL) { $env:UV_INDEX_URL } else { 'https://mirrors.aliyun.com/pypi/simple' }
$Script:DefaultHost = '127.0.0.1'
$Script:RedTraceHost = if ($env:REDTRACE_HOST) { $env:REDTRACE_HOST } else { $Script:DefaultHost }
$Script:RedTracePort = if ($env:REDTRACE_PORT) { [int]$env:REDTRACE_PORT } else { 8000 }
$Script:PlainTextSecrets = if ($env:REDTRACE_PLAINTEXT_SECRETS) { $env:REDTRACE_PLAINTEXT_SECRETS } else { '1' }
$Script:BraveSkillDir = Join-Path $Script:ProjectDir 'skills\brave-search'
$Script:GhidraSkillDir = Join-Path $Script:ProjectDir 'skills\ghidra-reverse'
$Script:PlaywrightSkillDir = Join-Path $Script:ProjectDir 'skills\playwright-skill'
$Script:GhidraInstallDir = if ($env:REDTRACE_GHIDRA_HOME) { $env:REDTRACE_GHIDRA_HOME } else { Join-Path $Script:ProjectDir '.redtrace\runtime\ghidra' }
$Script:RsactftoolVenv = if ($env:REDTRACE_RSACTFTOOL_VENV) { $env:REDTRACE_RSACTFTOOL_VENV } else { Join-Path $Script:ProjectDir '.redtrace\runtime\rsactftool' }
$Script:QilingVenv = if ($env:REDTRACE_QILING_VENV) { $env:REDTRACE_QILING_VENV } else { Join-Path $Script:ProjectDir '.redtrace\runtime\qiling' }
$Script:QilingWrapper = Join-Path $Script:ProjectDir 'skills\reverse-engineering\scripts\qiling-python'
$Script:NucleiVersion = if ($env:REDTRACE_NUCLEI_VERSION) { $env:REDTRACE_NUCLEI_VERSION } else { '3.11.0' }
$Script:CodegraphVersion = if ($env:REDTRACE_CODEGRAPH_VERSION) { $env:REDTRACE_CODEGRAPH_VERSION } else { '1.5.0' }
$Script:RsactftoolRevision = if ($env:REDTRACE_RSACTFTOOL_REVISION) { $env:REDTRACE_RSACTFTOOL_REVISION } else { '7c98848f1945de3e67a420871e8672f5ad9aa5d5' }
$Script:JavaInstallDir = if ($env:REDTRACE_JAVA_HOME) { $env:REDTRACE_JAVA_HOME } else { Join-Path $Script:ProjectDir '.redtrace\runtime\temurin-21' }

function Log { param([string]$Message) Write-Host "[RedTrace] $Message" }
function Warn { param([string]$Message) Write-Warning "[RedTrace] $Message" }
function Die { param([string]$Message) Write-Error "[RedTrace] $Message"; exit 1 }
function Has { param([string]$Command) [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

# Create tmp directory
New-Item -ItemType Directory -Path $Script:TmpDir -Force | Out-Null

# Export environment variables
$env:REDTRACE_ROOT = $Script:ProjectDir
$env:TMPDIR = $Script:TmpDir
$env:TMP = $Script:TmpDir
$env:TEMP = $Script:TmpDir
$env:XDG_CACHE_HOME = Join-Path $Script:ProjectDir '.redtrace\cache'
$env:XDG_CONFIG_HOME = Join-Path $Script:ProjectDir '.redtrace\config'
$env:XDG_DATA_HOME = Join-Path $Script:ProjectDir '.redtrace\data'
$env:UV_CACHE_DIR = Join-Path $Script:ProjectDir '.redtrace\cache\uv'
$env:NPM_CONFIG_CACHE = Join-Path $Script:ProjectDir '.redtrace\cache\npm'
$env:NPM_CONFIG_PREFIX = $Script:RuntimeDir
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Script:RuntimeDir 'playwright'
$env:GOPATH = Join-Path $Script:RuntimeDir 'go'
$env:GOBIN = $Script:BinDir
$env:CARGO_HOME = Join-Path $Script:RuntimeDir 'cargo'
$env:GEM_HOME = Join-Path $Script:RuntimeDir 'gems'

# Update PATH
$pathSeparator = [System.IO.Path]::PathSeparator
$env:PATH = "$($Script:BinDir)$pathSeparator$($Script:RuntimeDir)$pathSeparator$env:PATH"

# Helper functions
function Test-Admin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-WingetPackage {
    param([string]$PackageId, [string]$Name)
    if (Has 'winget') {
        $installed = winget list --id $PackageId --accept-source-agreements 2>$null
        if ($installed -match $PackageId) {
            Log "$Name already installed"
            return
        }
        Log "Installing $Name via winget"
        winget install --id $PackageId --accept-package-agreements --accept-source-agreements
    } else {
        Warn "winget not available, please install $Name manually"
    }
}

function Install-ChocoPackage {
    param([string]$PackageName, [string]$Name)
    if (Has 'choco') {
        $installed = choco list --local-only $PackageName 2>$null
        if ($installed -match $PackageName) {
            Log "$Name already installed"
            return
        }
        Log "Installing $Name via Chocolatey"
        choco install $PackageName -y
    } else {
        Warn "Chocolatey not available, please install $Name manually"
    }
}

function Ensure-Node {
    $major = 0
    if (Has 'node') {
        $version = node --version 2>$null
        if ($version -match '^v(\d+)') { $major = [int]$Matches[1] }
    }
    if ((Has 'npm') -and $major -ge 22) {
        Log "Node.js $(node --version) and npm are already installed"
        return
    }
    Log "Installing/upgrading Node.js"
    Install-WingetPackage -PackageId 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has 'node')) { Die "Node.js installation failed" }
    $version = node --version 2>$null
    if ($version -match '^v(\d+)') { $major = [int]$Matches[1] }
    if ($major -lt 22) { Die "Node.js 22 or newer is required" }
}

function Ensure-Java {
    $major = 0
    if (Has 'java') {
        $version = java -version 2>&1 | Select-String 'version' | ForEach-Object { $_.ToString() }
        if ($version -match '"(\d+)\.') { $major = [int]$Matches[1] }
        elseif ($version -match '"1\.(\d+)\.') { $major = [int]$Matches[1] }
    }
    if ($major -ge 21) {
        Log "Java $major already satisfies Ghidra"
        return
    }
    Log "Installing Temurin JDK 21"
    Install-WingetPackage -PackageId 'EclipseAdoptium.Temurin.21.JDK' -Name 'Temurin JDK 21'
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has 'java')) { Die "Java installation failed" }
}

function Ensure-Uv {
    if (Has 'uv') {
        Log "uv already installed: $(uv --version)"
        return
    }
    Log "Installing uv"
    irm https://astral.sh/uv/install.ps1 | iex
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has 'uv')) { Die "uv installation failed" }
}

function Ensure-Go {
    if (Has 'go') {
        Log "Go already installed: $(go version)"
        return
    }
    Log "Installing Go"
    Install-WingetPackage -PackageId 'GoLang.Go' -Name 'Go'
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has 'go')) { Die "Go installation failed" }
}

function Ensure-NpmCli {
    param([string]$Command, [string]$Package)
    if (Has $Command) {
        Log "$Command already installed"
        return
    }
    Log "Installing missing CLI $Command ($Package)"
    npm install -g --registry=$Script:NpmRegistry $Package
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has $Command)) { Die "$Command installation failed" }
}

function Ensure-Rtk {
    if (Has 'rtk') {
        Log "RTK already installed: $(rtk --version)"
        return
    }
    Log "Installing Rust Token Killer"
    irm https://raw.githubusercontent.com/rtk-ai/rtk/master/install.ps1 | iex
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Has 'rtk')) { Die "RTK installation failed" }
}

function Ensure-PlaywrightSkill {
    $skillMd = Join-Path $Script:PlaywrightSkillDir 'SKILL.md'
    $runJs = Join-Path $Script:PlaywrightSkillDir 'run.js'
    if (-not (Test-Path $skillMd)) { Die "playwright-skill SKILL.md is missing" }
    if (-not (Test-Path $runJs)) { Die "playwright-skill run.js is missing" }
    if (-not (Has 'node')) { Die "node is required for playwright-skill" }
    if (-not (Has 'npm')) { Die "npm is required for playwright-skill" }
    Push-Location $Script:PlaywrightSkillDir
    try {
        npm install
        npx playwright install chromium
    } finally {
        Pop-Location
    }
    Log "playwright-skill dependencies and Chromium are ready"
}

function Ensure-BraveSearchSkill {
    $skillMd = Join-Path $Script:BraveSkillDir 'SKILL.md'
    $packageLock = Join-Path $Script:BraveSkillDir 'package-lock.json'
    if (-not (Test-Path $skillMd)) { Die "brave-search SKILL.md is missing" }
    if (-not (Test-Path $packageLock)) { Die "brave-search package-lock.json is missing" }
    Push-Location $Script:BraveSkillDir
    try {
        $result = npm ls --depth=0 2>&1
        if ($LASTEXITCODE -eq 0) {
            Log "brave-search Node dependencies are already installed"
        } else {
            Log "Installing brave-search Node dependencies"
            npm ci --registry=$Script:NpmRegistry
        }
    } finally {
        Pop-Location
    }
}

function Install-SkillPythonDependencies {
    $python = Join-Path $Script:ToolVenv 'Scripts\python.exe'
    if (-not (Test-Path $python)) {
        Log "Creating security-tools Python environment"
        uv venv --python 3.12 $Script:ToolVenv
    }
    $entries = @(
        'pwntools==4.15.0|pwn',
        'pycryptodome==3.23.0|Crypto',
        'z3-solver==4.13.0.0|z3',
        'sympy==1.14.0|sympy',
        'pycparser==2.23|pycparser',
        'angr==9.2.193|angr',
        'frida-tools==14.8.0|frida',
        'requests==2.32.5|requests',
        'flask-unsign==1.2.1|flask_unsign',
        'sqlmap==1.10.3|sqlmap',
        'ropper==1.13.13|ropper',
        'ROPgadget==7.7|ropgadget',
        'volatility3==2.27.0|volatility3',
        'yara-python==4.5.4|yara',
        'pefile==2024.8.26|pefile',
        'capstone==5.0.3|capstone',
        'oletools==0.60.2|oletools',
        'unicorn==2.1.2|unicorn',
        'scapy==2.7.0|scapy',
        'Pillow==10.4.0|PIL',
        'numpy==2.2.6|numpy',
        'scipy==1.15.3|scipy',
        'matplotlib==3.10.8|matplotlib',
        'segno==1.6.6|segno',
        'shodan==1.31.0|shodan',
        'uncompyle6==3.9.3|uncompyle6',
        'lief==0.17.6|lief',
        'dnspython==2.8.0|dns',
        'dnslib==0.9.26|dnslib',
        'dissect.cobaltstrike==1.2.1|dissect.cobaltstrike'
    )
    foreach ($entry in $entries) {
        $parts = $entry -split '\|'
        $spec = $parts[0]
        $module = $parts[1]
        $result = & $python -c "import $module" 2>&1
        if ($LASTEXITCODE -eq 0) { continue }
        Log "Installing Python security package $spec"
        $result = uv pip install --python $python --index-url $Script:PyPIIndex $spec 2>&1
        if ($LASTEXITCODE -ne 0) {
            Warn "Python package unsupported on this platform and skipped: $spec"
        }
    }
}

function Prepare-LocalConfig {
    if (Test-Path $Script:ConfigPath) {
        Log "Using existing local config: $Script:ConfigPath"
        return
    }
    $exampleConfig = Join-Path $Script:ProjectDir 'redtrace.local.example.yaml'
    if (-not (Test-Path $exampleConfig)) { Die "redtrace.local.example.yaml is missing" }
    Copy-Item $exampleConfig $Script:ConfigPath
    $content = Get-Content $Script:ConfigPath -Raw
    $content = $content -replace 'workspace_root:.*', "workspace_root: `"$(Join-Path $Script:ProjectDir 'workspaces')`""
    Set-Content -Path $Script:ConfigPath -Value $content -Encoding UTF8
    Log "Created local config: $Script:ConfigPath"
}

function Start-Component {
    param([string]$Name, [string]$Command, [string[]]$Arguments)
    $pidFile = Join-Path $Script:RunDir "$Name.pid"
    if (Test-Path $pidFile) {
        $pid = Get-Content $pidFile
        if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
            Log "$Name already running (pid $pid)"
            return
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Log "Starting $Name"
    $logFile = Join-Path $Script:LogDir "$Name.log"
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $Command
    $processInfo.Arguments = $Arguments -join ' '
    $processInfo.WorkingDirectory = $Script:ProjectDir
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
        Get-Content $logFile -Tail 40 | Write-Error
        Die "$Name failed to start"
    }
    Log "$Name started (pid $($process.Id))"
}

function Test-BraveSearchSkill {
    if ($env:REDTRACE_SKIP_BRAVE_TEST -eq '1') {
        Log "Skipping brave-search API test"
        return
    }
    $apiKey = $env:BRAVE_API_KEY
    if ([string]::IsNullOrEmpty($apiKey)) {
        Warn "brave-search API test skipped because BRAVE_API_KEY is not configured"
        return
    }
    Log "Testing brave-search API"
    $skillDir = $Script:BraveSkillDir
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $env:BRAVE_API_KEY = $apiKey
        $env:NODE_USE_ENV_PROXY = '1'
        $result = node (Join-Path $skillDir 'search.js') "RedTrace collaborative agent framework" -n 1 2>&1
        if ($LASTEXITCODE -eq 0) {
            Log "brave-search API test passed"
            return
        }
        Warn "brave-search API test attempt $attempt failed"
        if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    }
    Die "brave-search API test failed after 3 attempts"
}

function Sync-RedTracePython {
    Log "Syncing RedTrace Python environment"
    $env:UV_INDEX_URL = $Script:PyPIIndex
    $result = uv sync --frozen --project (Join-Path $Script:ProjectDir 'redtrace') 2>&1
    if ($LASTEXITCODE -ne 0) {
        Warn "Configured PyPI mirror failed; retrying from official PyPI"
        $env:UV_INDEX_URL = 'https://pypi.org/simple'
        uv sync --frozen --project (Join-Path $Script:ProjectDir 'redtrace')
    }
}

# Main execution
Log "Starting RedTrace deployment on Windows"

# Check prerequisites
if (-not (Has 'git')) { Die "Git is required. Install it via winget: winget install Git.Git" }
if (-not (Has 'curl')) { Die "curl is required. It should be available on Windows 10+" }

# Install system dependencies via winget
Log "Checking system dependencies"

# Git
Install-WingetPackage -PackageId 'Git.Git' -Name 'Git'

# Python
if (-not (Has 'python')) {
    Log "Installing Python 3.12"
    Install-WingetPackage -PackageId 'Python.Python.3.12' -Name 'Python 3.12'
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
}

# Node.js
Ensure-Node

# Java (for Ghidra)
Ensure-Java

# Go (for security tools)
Ensure-Go

# uv (Python package manager)
Ensure-Uv

# codegraph
Ensure-NpmCli -Command 'codegraph' -Package "@colbymchenry/codegraph@$($Script:CodegraphVersion)"
Log "Verifying codegraph installation"
codegraph --version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Die "codegraph failed verification" }

# RTK
Ensure-Rtk

# Playwright
Ensure-PlaywrightSkill

# Brave Search
Ensure-BraveSearchSkill

# Ghidra (headless)
$ghidraSkillMd = Join-Path $Script:GhidraSkillDir 'SKILL.md'
if (-not (Test-Path $ghidraSkillMd)) { Die "ghidra-reverse SKILL.md is missing" }
if (-not (Has 'java')) { Die "Java is required for Ghidra" }
$ghidraHome = $env:GHIDRA_HOME
if ([string]::IsNullOrEmpty($ghidraHome)) {
    # Try to find Ghidra in common locations
    $ghidraPaths = @(
        (Join-Path $Script:GhidraInstallDir),
        (Join-Path $env:ProgramFiles 'Ghidra'),
        (Join-Path ${env:ProgramFiles(x86)} 'Ghidra')
    )
    foreach ($path in $ghidraPaths) {
        if (Test-Path (Join-Path $path 'support\analyzeHeadless.bat')) {
            $ghidraHome = $path
            break
        }
    }
}
if ([string]::IsNullOrEmpty($ghidraHome)) {
    Log "Ghidra not found. Please install Ghidra manually from https://ghidra-sre.org/"
    Warn "Set GHIDRA_HOME environment variable after installation"
} else {
    $env:GHIDRA_HOME = $ghidraHome
    Log "Ghidra found at: $ghidraHome"
}

# Nuclei
if (-not (Has 'nuclei')) {
    Log "Installing Nuclei"
    go install "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v$($Script:NucleiVersion)"
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
}
if (-not (Has 'nuclei')) { Die "Nuclei installation failed" }

# Optional security tools
if ($env:REDTRACE_SKIP_OPTIONAL_TOOLS -ne '1') {
    # RsaCtfTool
    $rsactftoolBin = Join-Path $Script:RsactftoolVenv 'Scripts\RsaCtfTool.exe'
    if (-not (Test-Path $rsactftoolBin)) {
        Log "Installing RsaCtfTool"
        uv venv --python 3.12 $Script:RsactftoolVenv
        $python = Join-Path $Script:RsactftoolVenv 'Scripts\python.exe'
        uv pip install --python $python --upgrade "git+https://github.com/RsaCtfTool/RsaCtfTool.git@$($Script:RsactftoolRevision)"
    }

    # Qiling
    $qilingPython = Join-Path $Script:QilingVenv 'Scripts\python.exe'
    $qilingTest = & $qilingPython -c "import qiling" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Log "Installing Qiling"
        uv venv --python 3.11 $Script:QilingVenv
        & $qilingPython -m ensurepip --upgrade
        & $qilingPython -m pip install qiling==1.4.6
    }

    # Install Python security packages
    Install-SkillPythonDependencies

    # Optional Go tools
    if (-not (Has 'ffuf')) {
        Log "Installing ffuf"
        $env:GOPROXY = 'https://goproxy.cn,direct'
        go install github.com/ffuf/ffuf/v2@latest
    }
} else {
    Log "Skipping optional Python and Ruby security tools"
}

# Prepare configuration
Prepare-LocalConfig

# Configure Brave API key
if ($env:BRAVE_API_KEY) {
    Log "Storing BRAVE_API_KEY in configuration"
    # This would need Python to handle properly
    Warn "BRAVE_API_KEY configuration requires Python integration"
}

# Test Brave Search
Test-BraveSearchSkill

# Create necessary directories
New-Item -ItemType Directory -Path $Script:RunDir -Force | Out-Null
New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Script:ProjectDir 'workspaces') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Script:ProjectDir 'output\webshell') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Script:ProjectDir 'output\c2') -Force | Out-Null

# Set environment for workers
$workerPath = @(
    $Script:BinDir,
    $Script:ToolVenv,
    $env:GOBIN,
    (Join-Path $Script:RuntimeDir 'gems\bin')
) -join $pathSeparator
$env:REDTRACE_LOCAL_PATH_PREPEND = $workerPath
$env:REDTRACE_DISPATCH_CONFIG = $Script:ConfigPath
$env:REDTRACE_PLAINTEXT_SECRETS = $Script:PlainTextSecrets

# Sync Python environment
Sync-RedTracePython

# Start components
$serverCommand = 'uv'
$serverArgs = @('run', '--project', (Join-Path $Script:ProjectDir 'redtrace'), 'redtrace', 'serve',
    '--db-path', (Join-Path $Script:ProjectDir '.redtrace\redtrace.db'),
    '--host', $Script:RedTraceHost,
    '--port', $Script:RedTracePort)

Start-Component -Name 'server' -Command $serverCommand -Arguments $serverArgs

Log "Waiting for RedTrace server"
$serverReady = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($Script:RedTracePort)/projects" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $serverReady = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $serverReady) {
    Get-Content (Join-Path $Script:LogDir 'server.log') -Tail 40 | Write-Error
    Die "Server health check timed out"
}

$dispatcherCommand = 'uv'
$dispatcherArgs = @('run', '--project', (Join-Path $Script:ProjectDir 'redtrace'), 'redtrace', 'dispatch',
    '--config', $Script:ConfigPath)

Start-Component -Name 'dispatcher' -Command $dispatcherCommand -Arguments $dispatcherArgs

# Display summary
$serverPid = Get-Content (Join-Path $Script:RunDir 'server.pid')
$dispatcherPid = Get-Content (Join-Path $Script:RunDir 'dispatcher.pid')

Write-Host @"

RedTrace local mode is running on Windows.
  UI:         http://$($Script:RedTraceHost):$($Script:RedTracePort)
  Config:     $($Script:ConfigPath)
  Server:     pid $serverPid, log $(Join-Path $Script:LogDir 'server.log')
  Dispatcher: pid $dispatcherPid, log $(Join-Path $Script:LogDir 'dispatcher.log')

Worker API settings override each process; empty settings keep the CLI's existing login/global configuration.

Optional controls:
  REDTRACE_SKIP_OPTIONAL_TOOLS=1  Skip the large security-tool set
  REDTRACE_SKIP_BRAVE_TEST=1      Skip the brave-search API smoke test
  REDTRACE_PLAINTEXT_SECRETS=1    Keep local API settings as plaintext
  REDTRACE_NO_OPEN=1              Do not open the browser automatically

Stop with:
  Stop-Process -Id $serverPid,$dispatcherPid

"@

# Open browser
if ($env:REDTRACE_NO_OPEN -ne '1') {
    Start-Process "http://$($Script:RedTraceHost):$($Script:RedTracePort)"
}

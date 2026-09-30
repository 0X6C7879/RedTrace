#!/usr/bin/env pwsh
# Start the Node runtime on Windows; start-redtrace.cmd installs its locked dependencies.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = if ($env:REDTRACE_CONFIG_PATH) { $env:REDTRACE_CONFIG_PATH } else { Join-Path $root 'redtrace.yaml' }
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $root 'redtrace.local.example.yaml') $config
}
& (Join-Path $root 'start-redtrace.cmd') --config $config @args
exit $LASTEXITCODE

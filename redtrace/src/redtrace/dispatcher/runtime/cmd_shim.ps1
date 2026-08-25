param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string]$ArgumentsPath
)

try {
    $json = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8
    [string[]]$Remaining = ConvertFrom-Json -InputObject $json
}
catch {
    Write-Error "Invalid RedTrace command arguments: $_"
    exit 2
}

& $Executable @Remaining
exit $LASTEXITCODE

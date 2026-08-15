[CmdletBinding()]
param(
    [string]$BuildTag = "redtrace-x-benchmark:build",
    [string]$FinalTag = "redtrace-x-benchmark:latest",
    [string]$OutputPath = "artifacts/redtrace-x-benchmark-upload.tar.gz",
    [switch]$KeepBuildImage
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$OutputPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectDir $OutputPath))
$ArtifactDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
$TempDir = Join-Path $ArtifactDir ("benchmark-image-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir | Out-Null
$ContainerName = "redtrace-x-flatten-" + [guid]::NewGuid().ToString("N")
$Completed = $false

try {
    $Pins = [ordered]@{
        NUCLEI_TEMPLATES_COMMIT = "e84ce385bfda7da56d73e9ecf2ff0e9a80ad7e3e"
        SECLISTS_COMMIT = "eedc5117b3f506d874d033c18786a218e7cec34c"
        PAYLOADS_COMMIT = "3bff425aca2b020f7334f9d744eed3ca55de8cdf"
        SEMGREP_RULES_COMMIT = "40b8c63f75dc7c22c8a77482d73bfb864b146f7e"
        JWT_TOOL_COMMIT = "3bc7407cf2222d6a821dcc19c776e5a1b1cb9a9b"
    }

    $BuildArgs = @("build", "--progress=plain", "-f", "Dockerfile.benchmark", "-t", $BuildTag)
    foreach ($entry in $Pins.GetEnumerator()) {
        $BuildArgs += @("--build-arg", "$($entry.Key)=$($entry.Value)")
    }
    $BuildArgs += "."
    $BuildSucceeded = $false
    for ($BuildAttempt = 1; $BuildAttempt -le 3; $BuildAttempt++) {
        & docker @BuildArgs
        if ($LASTEXITCODE -eq 0) {
            $BuildSucceeded = $true
            break
        }
        if ($BuildAttempt -lt 3) { Start-Sleep -Seconds (10 * $BuildAttempt) }
    }
    if (-not $BuildSucceeded) { throw "Docker build failed after 3 attempts" }

    & docker create --name $ContainerName $BuildTag | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to create flattening container" }
    $RootFs = Join-Path $TempDir "rootfs.tar"
    & docker export --output $RootFs $ContainerName
    if ($LASTEXITCODE -ne 0) { throw "Docker rootfs export failed" }

    $ImageConfig = (& docker image inspect $BuildTag | ConvertFrom-Json)[0].Config
    $ImportArgs = @("import")
    foreach ($item in $ImageConfig.Env) { $ImportArgs += @("--change", "ENV $item") }
    if ($ImageConfig.WorkingDir) { $ImportArgs += @("--change", "WORKDIR $($ImageConfig.WorkingDir)") }
    if ($ImageConfig.User) { $ImportArgs += @("--change", "USER $($ImageConfig.User)") }
    if ($ImageConfig.Entrypoint) {
        $ImportArgs += @("--change", "ENTRYPOINT $($ImageConfig.Entrypoint | ConvertTo-Json -Compress)")
    }
    if ($ImageConfig.Cmd) {
        $ImportArgs += @("--change", "CMD $($ImageConfig.Cmd | ConvertTo-Json -Compress)")
    }
    $ImportArgs += @($RootFs, $FinalTag)
    & docker @ImportArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker flattened-image import failed" }

    & docker rm $ContainerName | Out-Null
    $ContainerName = ""
    & docker run --rm --network none --entrypoint bash $FinalTag -lc "bash container/verify-offline.sh"
    if ($LASTEXITCODE -ne 0) { throw "Offline image verification failed" }

    $ImageTar = Join-Path $TempDir "image.tar"
    & docker save --output $ImageTar $FinalTag
    if ($LASTEXITCODE -ne 0) { throw "Docker save failed" }
    & gzip -9 -f -- $ImageTar
    if ($LASTEXITCODE -ne 0) { throw "gzip compression failed" }
    Move-Item -LiteralPath "$ImageTar.gz" -Destination $OutputPath -Force

    $Size = (Get-Item -LiteralPath $OutputPath).Length
    if ($Size -gt 3GB) {
        throw "Compressed image is $([math]::Round($Size / 1GB, 2)) GiB; hosted upload limit is 3 GiB"
    }
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
    [pscustomobject]@{
        image = $FinalTag
        archive = $OutputPath
        bytes = $Size
        sha256 = $Hash
        pins = $Pins
    } | ConvertTo-Json -Depth 3

    if (-not $KeepBuildImage) { & docker image rm $BuildTag | Out-Null }
    $Completed = $true
}
finally {
    if ($ContainerName) {
        $PreviousErrorPreference = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        & docker rm -f $ContainerName *> $null
        $ErrorActionPreference = $PreviousErrorPreference
    }
    if ($Completed -and (Test-Path -LiteralPath $TempDir)) {
        $ResolvedTemp = [System.IO.Path]::GetFullPath($TempDir)
        $ResolvedArtifact = [System.IO.Path]::GetFullPath($ArtifactDir)
        if ($ResolvedTemp.StartsWith($ResolvedArtifact + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $ResolvedTemp -Recurse -Force
        }
    }
}

# RedTrace_X Headless 测评单镜像构建流水线。
#
# 流程：
#   1. docker build（根目录 Dockerfile，代理经宿主机 7890 端口注入构建期）
#   2. docker export/import 压平为单层镜像（收尾 purge 才能真正减小体积）
#   3. --network none 离线冒烟测试（container/verify-headless.sh）
#   4. docker save | gzip -9 → 上传压缩包；> 3 GiB 直接失败
#
# 镜像中不含任何密钥：.env / redtrace.yaml 已在 .dockerignore 排除，
# BENCHMARK_TOKEN / BENCHMARK_BASE_URL / API_KEY 由平台运行时 ENV 注入。

[CmdletBinding()]
param(
    [string]$BuildTag = "redtrace-x-benchmark:build",
    [string]$FinalTag = "redtrace-x-benchmark:latest",
    [string]$OutputPath = "artifacts/redtrace-x-benchmark-upload.tar.gz",
    # 宿主机 127.0.0.1:7890 代理；容器内须经 host.docker.internal 回指宿主机
    [string]$Proxy = "http://host.docker.internal:7890",
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
        JWT_TOOL_COMMIT = "3bc7407cf2222d6a821dcc19c776e5a1b1cb9a9b"
    }

    # BUILD_PROXY（下划线前缀，BuildKit 不会注入为 RUN 环境）仅供 RUN 层显式使用；
    # 不能传 HTTP(S)_PROXY 预定义参数，否则 apt 走代理拉国内镜像源会失败。
    $BuildArgs = @("build", "--progress=plain", "-f", "Dockerfile", "-t", $BuildTag,
        "--build-arg", "BUILD_PROXY=$Proxy")
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
    & docker run --rm --network none --entrypoint bash $FinalTag -lc "bash container/verify-headless.sh"
    if ($LASTEXITCODE -ne 0) { throw "Headless image verification failed" }

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

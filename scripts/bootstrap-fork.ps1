# Bootstrap a published Windows fork binary without touching OMP state.
# Usage:
#   irm https://raw.githubusercontent.com/th3akii/oh-my-pi/main/scripts/bootstrap-fork.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/th3akii/oh-my-pi/main/scripts/bootstrap-fork.ps1))) -TargetPath C:\path\to\omp.exe

param(
    [string]$TargetPath
)

$ErrorActionPreference = "Stop"
$Repository = "th3akii/oh-my-pi"
$BinaryName = "omp-windows-x64.exe"
$ApiVersion = "2022-11-28"
$VersionOutputPattern = '^omp/[0-9]+\.[0-9]+\.[0-9]+ \(th3akii/oh-my-pi, [0-9a-f]{7,40}\)$'

function Get-TargetPath {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        return [System.IO.Path]::GetFullPath($RequestedPath)
    }

    try {
        $command = Get-Command omp.exe -ErrorAction Stop
    } catch {
        throw "Could not find omp.exe on PATH. Re-run with -TargetPath <existing omp.exe path>."
    }
    return [System.IO.Path]::GetFullPath($command.Source)
}

$target = Get-TargetPath $TargetPath
if ([System.IO.Path]::GetExtension($target) -ne ".exe") {
    throw "Target must be a Windows executable: $target"
}
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Target executable does not exist: $target"
}
Write-Host "Replacing OMP executable: $target"

$headers = @{
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = $ApiVersion
}
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -TimeoutSec 60
if ($release.draft -ne $false -or $release.prerelease -ne $false) {
    throw "Latest fork release is not a published stable release"
}
$tag = [string]$release.tag_name
if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Latest fork release has an invalid stable tag: $tag"
}
$assets = @($release.assets | Where-Object { $_.name -eq $BinaryName })
if ($release.assets.Count -ne 1 -or $assets.Count -ne 1) {
    throw "Latest fork release must contain exactly one $BinaryName asset"
}
$asset = $assets[0]
$expectedUrl = "https://github.com/$Repository/releases/download/$tag/$BinaryName"
if ($asset.browser_download_url -ne $expectedUrl) {
    throw "Fork release asset URL is unexpected: $($asset.browser_download_url)"
}
if ([string]$asset.digest -notmatch '^sha256:([0-9a-f]{64})$') {
    throw "Fork release asset does not expose a strict SHA-256 digest"
}
$expectedDigest = $Matches[1].ToLowerInvariant()

$targetDirectory = Split-Path -Parent $target
$token = [guid]::NewGuid().ToString("N")
$temp = Join-Path $targetDirectory ".omp-fork-$token.download"
$backup = Join-Path $targetDirectory ".omp-fork-$token.old"
$tempCreated = $false
$backupReady = $false
try {
    Write-Host "Downloading $tag/$BinaryName..."
    Invoke-WebRequest -Uri $expectedUrl -OutFile $temp -TimeoutSec 900
    $tempCreated = $true

    $actualDigest = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) {
        throw "Downloaded binary SHA-256 mismatch: expected $expectedDigest, received $actualDigest"
    }

    $versionOutput = (& $temp --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch $VersionOutputPattern) {
        throw "Downloaded binary did not report the expected fork identity: $versionOutput"
    }
    Write-Host "Verified downloaded build: $versionOutput"

    Move-Item -LiteralPath $target -Destination $backup
    $backupReady = $true
    Move-Item -LiteralPath $temp -Destination $target
    $tempCreated = $false

    $installedOutput = (& $target --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $installedOutput -notmatch $VersionOutputPattern) {
        throw "Installed binary failed identity verification: $installedOutput"
    }
    Remove-Item -LiteralPath $backup -Force
    $backupReady = $false
    Write-Host "[OK] Installed $tag at $target"
    Write-Host "Existing ~/.omp and project-local .omp state were not modified."
} catch {
    if ($tempCreated -and (Test-Path -LiteralPath $temp)) {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
    if ($backupReady) {
        Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $backup -Destination $target -Force
        Write-Host "Restored previous OMP executable at $target" -ForegroundColor Yellow
    }
    throw
}

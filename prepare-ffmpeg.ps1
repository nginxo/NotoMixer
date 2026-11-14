[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$runtimeRoot = Join-Path $projectRoot '.runtime\ffmpeg'
$runtimeBin = Join-Path $runtimeRoot 'bin'
$ffmpegPath = Join-Path $runtimeBin 'ffmpeg.exe'
$ffprobePath = Join-Path $runtimeBin 'ffprobe.exe'
$markerPath = Join-Path $runtimeRoot 'SOURCE.txt'
$noticePath = Join-Path $runtimeRoot 'NOTICE.txt'
$downloadsRoot = Join-Path $projectRoot '.build-tools\downloads'
$assetName = 'ffmpeg-n8.1.3-35-gf1acb0a266-win64-lgpl-shared-8.1.zip'
$assetUrl = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-13-12-43/$assetName"
$expectedSha256 = '57cb10e4703b88edf55aa49e94dee19fd12f555f82ed3493a8cd70c847699996'
$archivePath = Join-Path $downloadsRoot $assetName
$sourceMarker = "$assetUrl`nSHA256: $expectedSha256"

if (
    (Test-Path -LiteralPath $ffmpegPath) -and
    (Test-Path -LiteralPath $ffprobePath) -and
    (Test-Path -LiteralPath $markerPath) -and
    (Test-Path -LiteralPath $noticePath) -and
    ((Get-Content -LiteralPath $markerPath -Raw).Trim() -eq $sourceMarker.Trim())
) {
    Write-Host 'FFmpeg LGPL runtime is ready.'
    exit 0
}

New-Item -ItemType Directory -Path $downloadsRoot -Force | Out-Null
$archiveIsValid = $false
if (Test-Path -LiteralPath $archivePath) {
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $archiveIsValid = $archiveHash -eq $expectedSha256
}

if (-not $archiveIsValid) {
    $downloadPath = "$archivePath.download"
    if (Test-Path -LiteralPath $downloadPath) {
        Remove-Item -LiteralPath $downloadPath -Force
    }
    Write-Host 'Downloading the pinned FFmpeg 8.1 LGPL runtime...'
    Invoke-WebRequest -Uri $assetUrl -OutFile $downloadPath
    $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadHash -ne $expectedSha256) {
        Remove-Item -LiteralPath $downloadPath -Force
        throw "FFmpeg SHA256 mismatch. Expected $expectedSha256, received $downloadHash."
    }
    Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
}

$stagingRoot = Join-Path $projectRoot ('.build-tools\ffmpeg-staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

try {
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingRoot
    $extractedFfmpeg = Get-ChildItem -LiteralPath $stagingRoot -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
    if (-not $extractedFfmpeg) {
        throw 'The verified FFmpeg archive does not contain ffmpeg.exe.'
    }
    $extractedBin = $extractedFfmpeg.Directory.FullName
    $extractedFfprobePath = Join-Path $extractedBin 'ffprobe.exe'
    if (-not (Test-Path -LiteralPath $extractedFfprobePath)) {
        throw 'The verified FFmpeg archive does not contain ffprobe.exe.'
    }
    $bundleRoot = Split-Path -Parent $extractedBin
    $licensePath = Join-Path $bundleRoot 'LICENSE.txt'
    if (-not (Test-Path -LiteralPath $licensePath)) {
        throw 'The verified FFmpeg archive does not contain LICENSE.txt.'
    }

    $resolvedRuntimeRoot = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\')
    if (-not $resolvedRuntimeRoot.StartsWith("$projectRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime path is outside the project: $resolvedRuntimeRoot"
    }
    if (Test-Path -LiteralPath $resolvedRuntimeRoot) {
        Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $runtimeBin -Force | Out-Null
    Copy-Item -LiteralPath $extractedFfmpeg.FullName -Destination $ffmpegPath
    Copy-Item -LiteralPath $extractedFfprobePath -Destination $ffprobePath
    Get-ChildItem -LiteralPath $extractedBin -Filter '*.dll' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeBin $_.Name)
    }
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $runtimeRoot 'LICENSE.txt')
    Set-Content -LiteralPath $markerPath -Value $sourceMarker -Encoding UTF8
    Set-Content -LiteralPath $noticePath -Encoding UTF8 -Value @(
        'NotoMixer uses an unmodified FFmpeg shared-library build for ALAC/M4A compatibility.'
        'FFmpeg is licensed under GNU LGPL version 3 or later; see LICENSE.txt.'
        'The exact upstream binary source and its SHA256 are recorded in SOURCE.txt.'
    )
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

Write-Host 'FFmpeg LGPL runtime is ready.'

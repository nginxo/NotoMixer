[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$SkipDependencies,
    [string]$InnoCompiler
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$packagePath = Join-Path $projectRoot 'package.json'
$distRoot = Join-Path $projectRoot 'dist'
$packagedAppRoot = Join-Path $distRoot 'app\NotoMixer-win32-x64'
$launcherOutputRoot = Join-Path $distRoot 'launcher'
$launcherOutput = Join-Path $launcherOutputRoot 'NotoMixer.exe'
$launcherSource = Join-Path $projectRoot 'installer\launcher\Program.cs'
$installerOutputRoot = Join-Path $distRoot 'installer'
$installerScript = Join-Path $projectRoot 'installer\NotoMixer.iss'
$iconSource = Join-Path $projectRoot 'logo.png'
$iconOutput = Join-Path $projectRoot 'installer\assets\NotoMixer.ico'
$toolsRoot = Join-Path $projectRoot '.build-tools'
$localInnoRoot = Join-Path $toolsRoot 'Inno Setup 7'
$innoDownload = Join-Path $toolsRoot 'innosetup-7.0.2-x64.exe'
$innoDownloadUrl = 'https://github.com/jrsoftware/issrc/releases/download/is-7_0_2/innosetup-7.0.2-x64.exe'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Comando richiesto non trovato: $Name"
    }
    return $command.Source
}

function Remove-BuildDirectory {
    param([string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $fullPath.StartsWith("$projectRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rimozione rifiutata: '$fullPath' non è dentro il progetto."
    }

    if (Test-Path -LiteralPath $fullPath) {
        Write-Host "Rimuovo $fullPath"
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function New-PngIcon {
    param(
        [string]$Source,
        [string]$Destination
    )

    Add-Type -AssemblyName System.Drawing
    $destinationDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

    $sourceImage = [Drawing.Image]::FromFile($Source)
    $bitmap = $null
    $graphics = $null
    $memory = $null
    $writer = $null

    try {
        $bitmap = New-Object Drawing.Bitmap 256, 256
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, 256, 256)

        $memory = New-Object IO.MemoryStream
        $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
        $pngBytes = $memory.ToArray()

        $fileStream = [IO.File]::Open(
            $Destination,
            [IO.FileMode]::Create,
            [IO.FileAccess]::Write
        )
        $writer = New-Object IO.BinaryWriter $fileStream

        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]1)
        $writer.Write([Byte]0)
        $writer.Write([Byte]0)
        $writer.Write([Byte]0)
        $writer.Write([Byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$pngBytes.Length)
        $writer.Write([UInt32]22)
        $writer.Write($pngBytes)
    }
    finally {
        if ($writer) { $writer.Dispose() }
        if ($memory) { $memory.Dispose() }
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
        $sourceImage.Dispose()
    }
}

function Find-InnoCompiler {
    param([string]$ExplicitPath)

    $candidates = @(
        $ExplicitPath,
        (Join-Path $localInnoRoot 'ISCC.exe'),
        (Join-Path ${env:ProgramFiles} 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles} 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }

    return $null
}

function Install-LocalInnoCompiler {
    New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

    if (-not (Test-Path -LiteralPath $innoDownload)) {
        Write-Step 'Scarico il compilatore ufficiale Inno Setup 7.0.2'
        Invoke-WebRequest -Uri $innoDownloadUrl -OutFile $innoDownload
    }

    $signature = Get-AuthenticodeSignature -FilePath $innoDownload
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Firma Authenticode di Inno Setup non valida: $($signature.Status)"
    }
    if ($signature.SignerCertificate.Subject -notmatch 'Pyrsys B\.V\.') {
        throw "Publisher Inno Setup inatteso: $($signature.SignerCertificate.Subject)"
    }

    Write-Step 'Installazione locale e silenziosa del compilatore'
    $arguments = @(
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
        '/CURRENTUSER',
        "/DIR=`"$localInnoRoot`""
    )
    $process = Start-Process `
        -FilePath $innoDownload `
        -ArgumentList $arguments `
        -Wait `
        -PassThru `
        -WindowStyle Hidden

    if ($process.ExitCode -ne 0) {
        throw "Installazione di Inno Setup fallita (codice $($process.ExitCode))."
    }

    $compiler = Join-Path $localInnoRoot 'ISCC.exe'
    if (-not (Test-Path -LiteralPath $compiler)) {
        throw "ISCC.exe non trovato dopo l'installazione in '$localInnoRoot'."
    }

    return $compiler
}

Write-Step 'Controllo del progetto'
Assert-Command 'node.exe' | Out-Null
Assert-Command 'npm.cmd' | Out-Null

if (-not (Test-Path -LiteralPath $packagePath)) {
    throw "package.json non trovato in '$projectRoot'."
}
if (-not (Test-Path -LiteralPath $installerScript)) {
    throw "Script Inno Setup non trovato in '$installerScript'."
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$appVersion = [string]$package.version
if ($appVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "Versione '$appVersion' non compatibile con VersionInfoVersion."
}

if ($Clean) {
    Write-Step 'Pulizia degli output precedenti'
    Remove-BuildDirectory (Join-Path $distRoot 'app')
    Remove-BuildDirectory $launcherOutputRoot
    Remove-BuildDirectory $installerOutputRoot
}

if (-not $SkipDependencies) {
    Write-Step 'Installazione/aggiornamento delle dipendenze Node'
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm install è terminato con codice $LASTEXITCODE."
    }
}

Write-Step 'Generazione dell’icona Windows'
New-PngIcon -Source $iconSource -Destination $iconOutput

$csharpCompilers = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csharpCompiler = $csharpCompilers |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $csharpCompiler) {
    throw 'Compilatore C# di Windows non trovato.'
}
if (-not (Test-Path -LiteralPath $launcherSource)) {
    throw "Sorgente del launcher non trovato in '$launcherSource'."
}

Write-Step '!!! Compilazione del launcher NotoMixer.exe'
New-Item -ItemType Directory -Path $launcherOutputRoot -Force | Out-Null
& $csharpCompiler `
    /nologo `
    /target:winexe `
    /optimize+ `
    /platform:anycpu `
    /reference:System.Windows.Forms.dll `
    "/win32icon:$iconOutput" `
    "/out:$launcherOutput" `
    $launcherSource
if ($LASTEXITCODE -ne 0) {
    throw "Compilazione del launcher terminata con codice $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $launcherOutput)) {
    throw 'Launcher NotoMixer.exe non creato.'
}

$packager = Join-Path $projectRoot 'node_modules\@electron\packager\bin\electron-packager.mjs'
if (-not (Test-Path -LiteralPath $packager)) {
    throw "@electron/packager non trovato. Riesegui senza -SkipDependencies."
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Write-Step "Creazione del pacchetto Electron x64 (NotoMixer $appVersion)"

$packagerArguments = @(
    $projectRoot,
    'NotoMixer',
    '--platform=win32',
    '--arch=x64',
    "--out=$(Join-Path $distRoot 'app')",
    '--overwrite',
    '--asar',
    '--prune=true',
    "--app-version=$appVersion",
    "--icon=$iconOutput",
    '--ignore=^/(dist|installer|assets|settings|\.build-tools|\.git|\.cover_cache)($|/)',
    '--ignore=^/(config\.notomixer|logo\.svg|logo\.png|desktopApp\.zip|notoMixer\.ino|build-installer\.ps1|INSTALLER\.md|avvia\.bat|\.gitignore)$'
)

& node.exe $packager @packagerArguments
if ($LASTEXITCODE -ne 0) {
    throw "Electron Packager è terminato con codice $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath (Join-Path $packagedAppRoot 'NotoMixer.exe'))) {
    throw "Pacchetto Electron incompleto: NotoMixer.exe non trovato."
}

$asarPath = Join-Path $packagedAppRoot 'resources\app.asar'
$asarCli = Join-Path $projectRoot 'node_modules\@electron\asar\bin\asar.mjs'
if (-not (Test-Path -LiteralPath $asarPath)) {
    throw "Pacchetto Electron incompleto: app.asar non trovato."
}
if (-not (Test-Path -LiteralPath $asarCli)) {
    throw "Utility ASAR non trovata."
}

Write-Step 'Verifica dei file applicativi inclusi'
$asarEntries = & node.exe $asarCli list $asarPath
if ($LASTEXITCODE -ne 0) {
    throw "Lettura di app.asar fallita con codice $LASTEXITCODE."
}

$requiredEntries = @(
    '\main.js',
    '\app-updater.js',
    '\renderer.js',
    '\index.html',
    '\splash.html',
    '\notomixer-config.js',
    '\user-settings.js',
    '\tablet-controller\index.html'
)
foreach ($entry in $requiredEntries) {
    if ($asarEntries -notcontains $entry) {
        throw "File richiesto assente da app.asar: $entry"
    }
}

$forbiddenPatterns = @(
    '*desktopApp.zip*',
    '*build-installer.ps1*',
    '*INSTALLER.md*',
    '*avvia.bat*',
    '*\.gitignore*',
    '*\installer\*',
    '*\.build-tools\*',
    '*NotoMixer.ino*',
    '*\config.notomixer*',
    '*\assets\*',
    '*\settings\*',
    '*\logo.svg*',
    '*\logo.png*'
)
foreach ($pattern in $forbiddenPatterns) {
    if ($asarEntries -like $pattern) {
        throw "File di sviluppo inatteso in app.asar: $pattern"
    }
}

$externalEntries = @(
    (Join-Path $projectRoot 'config.notomixer'),
    (Join-Path $projectRoot 'assets\audio\error.mp3'),
    (Join-Path $projectRoot 'assets\audio\test-audio.mp3'),
    (Join-Path $projectRoot 'assets\images\splash.png'),
    (Join-Path $projectRoot 'settings\userSettings.notomixer'),
    (Join-Path $projectRoot 'LICENSE'),
    (Join-Path $projectRoot 'logo.svg'),
    (Join-Path $projectRoot 'logo.png')
)
foreach ($entry in $externalEntries) {
    if (-not (Test-Path -LiteralPath $entry)) {
        throw "File esterno modificabile assente: $entry"
    }
}

$compiler = Find-InnoCompiler -ExplicitPath $InnoCompiler
if (-not $compiler) {
    $compiler = Install-LocalInnoCompiler
}

Write-Step 'Compilazione del setup EXE cifrato'
& $compiler "/DAppVersion=$appVersion" $installerScript
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup Compiler è terminato con codice $LASTEXITCODE."
}

$setupPath = Join-Path $installerOutputRoot "NotoMixer$appVersion-win64Shipping.exe"
if (-not (Test-Path -LiteralPath $setupPath)) {
    throw "Setup compilato non trovato in '$setupPath'."
}

$setupFile = Get-Item -LiteralPath $setupPath
$setupHash = Get-FileHash -LiteralPath $setupPath -Algorithm SHA256

Write-Host ''
Write-Host 'Installer creato con successo.' -ForegroundColor Green
Write-Host "File:    $($setupFile.FullName)"
Write-Host ('Size:    {0:N1} MB' -f ($setupFile.Length / 1MB))
Write-Host "SHA-256: $($setupHash.Hash)"


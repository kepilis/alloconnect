param(
    [Parameter(Mandatory)][string]$BaseApk,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$JavaDirectory,
    [Parameter(Mandatory)][string]$BuildTools,
    [Parameter(Mandatory)][string]$SigningDirectory,
    [string]$Version = '0.16.19',
    [int]$VersionCode = 56,
    [Parameter(Mandatory)][string]$Notes
)

$ErrorActionPreference = 'Stop'
$pinnedBaseHash = '43DD96CCB592E68B3707783B5D827D88505BA98213D02D162D01AC6631FC1DFA'
$alias = 'alloconnect-android'
$java = Join-Path $JavaDirectory 'java.exe'
$apksigner = Join-Path $BuildTools 'lib\apksigner.jar'
$zipalign = Join-Path $BuildTools 'zipalign.exe'
$aapt = Join-Path $BuildTools 'aapt.exe'
$prepare = Join-Path $PSScriptRoot 'prepare-apk.cjs'

function Invoke-BuildTool {
    param([string]$Program, [string[]]$Arguments)
    $output = & $Program @Arguments | Out-String -Stream
    if ($LASTEXITCODE -ne 0) {
        throw "Build tool failed ($LASTEXITCODE): $Program"
    }
    $output
}

if ((Get-FileHash -LiteralPath $BaseApk -Algorithm SHA256).Hash -ne $pinnedBaseHash) {
    throw 'Unexpected base APK SHA-256'
}
$baseCert = Invoke-BuildTool $java @('-jar', $apksigner, 'verify', '--print-certs', $BaseApk) |
    Select-String '^Signer #1 certificate SHA-256 digest:' | Select-Object -ExpandProperty Line
if (!$baseCert) { throw 'Base APK certificate fingerprint is missing' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$keyStore = Join-Path $SigningDirectory 'android-release.p12'
$passwordFile = Join-Path $SigningDirectory 'android-release.password'
$updateKey = Join-Path $SigningDirectory 'update-private.pem'
$signingFiles = @($keyStore, $passwordFile, $updateKey)

if (@($signingFiles | Where-Object { !(Test-Path -LiteralPath $_) }).Count) {
    throw 'Signing files are missing'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$replacements = [ordered]@{
    'AndroidManifest.xml' = 'AndroidManifest.xml'
    'assets/public/app.js' = 'base-app.js'
}
$aligned = Join-Path $OutputDirectory 'aligned.apk'
$signed = Join-Path $OutputDirectory ("alloconnect_android-$Version-arm64-v8a.apk")
$archive = [IO.Compression.ZipFile]::OpenRead($BaseApk)
try {
    foreach ($entry in $replacements.Keys) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry($entry), (Join-Path $OutputDirectory $replacements[$entry]), $true)
    }
} finally {
    $archive.Dispose()
}
Invoke-BuildTool $Node @($prepare, 'prepare', $OutputDirectory, $Version, "$VersionCode", $updateKey)
Invoke-BuildTool $Node @($prepare, 'archive', $OutputDirectory, $Version, "$VersionCode", $updateKey, $BaseApk)
$env:ALLOCONNECT_APK_PASSWORD = [IO.File]::ReadAllText($passwordFile)
try {
    Invoke-BuildTool $java @('-jar', $apksigner, 'sign', '--ks', $keyStore, '--ks-key-alias', $alias,
        '--ks-pass', 'env:ALLOCONNECT_APK_PASSWORD', '--out', $signed, $aligned)
} finally {
    Remove-Item Env:ALLOCONNECT_APK_PASSWORD
}
$signedCert = Invoke-BuildTool $java @('-jar', $apksigner, 'verify', '--print-certs', $signed) |
    Select-String '^Signer #1 certificate SHA-256 digest:' | Select-Object -ExpandProperty Line
if ($signedCert -ne $baseCert) { throw 'APK certificate does not match the published Android package' }
Invoke-BuildTool $zipalign @('-c', '-P', '16', '4', $signed)
$badging = Invoke-BuildTool $aapt @('dump', 'badging', $signed)
if (!($badging -match "^package: name='com\.alloconnect\.alo' versionCode='$VersionCode' versionName='$([regex]::Escape($Version))'")) {
    throw 'Unexpected signed package identity or version'
}
if (!($badging -match "^native-code: 'arm64-v8a'\s*$")) { throw 'Unexpected APK architecture' }
Invoke-BuildTool $Node @($prepare, 'describe', $OutputDirectory, $Version, "$VersionCode", $updateKey, $Notes)
Write-Output $signed

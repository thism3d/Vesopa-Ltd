# Pontardawe RFC for Android: the Play Store bundle (.aab) and an installable APK.
#
# From the repository root, in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File PontardaweRFC\build-android.ps1
#
# Writes PontardaweRFC-<version>-<build>.aab and .apk to Desktop\Android-builds.
# The version and build number are venue.json's: raise "build" for every
# upload to Play, which refuses a number it has seen before.
#
# Needs, once: Flutter on PATH, JDK 17 and the Android SDK (as for the other
# Vesopa apps), the upload key's android\key.properties beside vesopa_loyalty
# or MetricMembership\app, and PontardaweRFC\google-services.json, which
#   python vesopa_loyalty\tool\firebase_android_app.py PontardaweRFC
# fetches with the Firebase Admin SDK key.

$ErrorActionPreference = 'Stop'
$venueDir = $PSScriptRoot
$repo = Split-Path -Parent $venueDir
$venue = Get-Content (Join-Path $venueDir 'venue.json') -Raw | ConvertFrom-Json

function Run($what, [scriptblock]$cmd) {
    Write-Host "== $what" -ForegroundColor Cyan
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if (-not (Test-Path (Join-Path $venueDir 'google-services.json'))) {
    Run 'Firebase: register the app and fetch google-services.json' {
        python (Join-Path $repo 'vesopa_loyalty\tool\firebase_android_app.py') $venueDir
    }
}

Run 'Make the Pontardawe RFC project' {
    python (Join-Path $repo 'vesopa_loyalty\tool\make_venue_app.py') $venueDir
}

$app = Join-Path $venueDir 'build\app'
Push-Location $app
try {
    Run 'flutter pub get' { flutter pub get }
    Run 'Build the Play bundle' { flutter build appbundle --release --dart-define-from-file=venue_defines.json }
    Run 'Build the APK' { flutter build apk --release --dart-define-from-file=venue_defines.json }
} finally {
    Pop-Location
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Android-builds'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$name = "PontardaweRFC-$($venue.version)-$($venue.build)"
Copy-Item (Join-Path $app 'build\app\outputs\bundle\release\app-release.aab') (Join-Path $out "$name.aab") -Force
Copy-Item (Join-Path $app 'build\app\outputs\flutter-apk\app-release.apk') (Join-Path $out "$name.apk") -Force
Write-Host ""
Write-Host "Done: $out\$name.aab (Play) and $name.apk (install directly)" -ForegroundColor Green

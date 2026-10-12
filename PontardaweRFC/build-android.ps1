# Pontardawe RFC for Android: the Play Store bundle (.aab) and an installable APK.
#
# From the repository root, in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File PontardaweRFC\build-android.ps1
#
# or double-click build-android.cmd beside it, which also stops a leftover
# Gradle daemon and sets the Java temp folder this PC needs.
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

# The Android SDK and JDK 17, found here rather than trusted to the window:
# an Administrator window can run as another account, whose ANDROID_HOME and
# Flutter settings (%APPDATA%\.flutter_settings) are not azureuser's, and then
# Flutter says "No Android SDK found" although the SDK is on this PC.
$candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT,
    [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    'C:\Users\azureuser\AppData\Local\Android\Sdk') + @(
    # The SDK on this PC was installed from inside the Claude desktop app,
    # which is a packaged (MSIX) app: Windows quietly moved its AppData\Local
    # writes into the app's own LocalCache. Seen from Claude it is at
    # AppData\Local\Android\Sdk; from any other window, only here.
    Get-ChildItem 'C:\Users\azureuser\AppData\Local\Packages' -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'LocalCache\Local\Android\Sdk' }) |
    Where-Object { $_ } | Select-Object -Unique
$sdk = $candidates | Where-Object {
    (Test-Path (Join-Path $_ 'platform-tools')) -or (Test-Path (Join-Path $_ 'platforms')) -or (Test-Path (Join-Path $_ 'build-tools'))
} | Select-Object -First 1
if (-not $sdk) {
    $seen = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($seen) {
        $why = try { (Get-ChildItem $seen -ErrorAction Stop | Select-Object -ExpandProperty Name) -join ', ' } catch { $_.Exception.Message }
        throw "This window, running as $env:USERNAME, can't use the Android SDK at $seen ($why). Close it and run the build from a normal window: double-click PontardaweRFC\build-android.cmd in File Explorer, not 'Run as administrator'."
    }
    throw "No Android SDK on this PC (looked in: $($candidates -join '; '))."
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
if (-not ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe')))) {
    $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}
# Java needs a short temp folder for its sockets on this PC.
New-Item -ItemType Directory -Force -Path 'C:\gtmp' | Out-Null
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:\gtmp'
Write-Host "Android SDK: $sdk   Java: $env:JAVA_HOME   as $env:USERNAME"
Run 'Tell Flutter where the Android SDK and Java are' {
    if ($env:JAVA_HOME) { flutter config --android-sdk $sdk --jdk-dir $env:JAVA_HOME } else { flutter config --android-sdk $sdk }
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

# Firebase App Distribution (owner, 2026-10-12): when the Firebase CLI is on
# this PC and signed in, the new build goes straight to testers. The groups
# come from venue.json firebase_tester_groups (comma separated aliases from
# Firebase > App Distribution > Testers & Groups); with none, the release is
# uploaded and waits in the console for testers to be added. A failure here
# never undoes the build above.
$firebase = Get-Command firebase -ErrorAction SilentlyContinue
if ($firebase -and $venue.firebase_android_app) {
    $notes = "Pontardawe RFC $($venue.version) ($($venue.build)): sign-in with the phone's own Google and passkey sheets, two-step codes in the app."
    $fbArgs = @('appdistribution:distribute', (Join-Path $out "$name.apk"), '--app', $venue.firebase_android_app, '--release-notes', $notes)
    if ($venue.firebase_tester_groups) { $fbArgs += @('--groups', $venue.firebase_tester_groups) }
    Write-Host ""
    Write-Host "== Firebase App Distribution" -ForegroundColor Cyan
    & firebase @fbArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Sent to Firebase App Distribution." -ForegroundColor Green
    } else {
        Write-Host "Firebase App Distribution did not take it (exit $LASTEXITCODE); the build itself is fine." -ForegroundColor Yellow
    }
}

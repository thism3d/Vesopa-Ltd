<#
.SYNOPSIS
  Build, sign and (with -Publish) upload our own Windows installers.

.DESCRIPTION
  "I think exe with a private link for time being will be good. That allows us
  to control what versions people are on." (Nicki Tidbell, 2026-10-05)

  For each app: flutter build windows, sign the program, wrap it in an Inno
  Setup installer (installer\vesopa-app.iss), sign the installer, and with
  -Publish put it on https://admin.vesopa.com/downloads (tool/publish_installers.py).
  The Microsoft Store packages are untouched: this is a second way out, not a
  replacement.

  Installers land in dist\installers\, named like VesopaEPOS-Setup-1.14.2.exe.
  The version is the app's pubspec `version:` (without the +build part), so it
  matches the Store build of the same code.

  SIGNING (Azure Trusted Signing). Signs when these are set in .env.claude-tools
  or .env.claude, and otherwise builds unsigned and says so:
    TRUSTED_SIGNING_ENDPOINT   e.g. https://weu.codesigning.azure.net
    TRUSTED_SIGNING_ACCOUNT    the Trusted Signing account name
    TRUSTED_SIGNING_PROFILE    the certificate profile name
    AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
                               an app registration given the
                               "Trusted Signing Certificate Profile Signer" role
  Unsigned installers work: Windows shows "Windows protected your PC", and
  More info, then Run anyway, installs it.

  Needs: Flutter, Inno Setup 6 or 7 (winget install JRSoftware.InnoSetup) and, for
  -Publish, Python with the server login in .env.claude.

.EXAMPLE
  .\tool\build-installers.ps1                          # all five, no upload
  .\tool\build-installers.ps1 -Apps till -Publish      # the till, then Downloads
  .\tool\build-installers.ps1 -Apps till,kitchen -Publish -Notes "Open price fix"
#>
[CmdletBinding()]
param(
  [ValidateSet('till', 'kitchen', 'display', 'express', 'loyalty')]
  [string[]] $Apps = @('till', 'kitchen', 'display', 'express', 'loyalty'),
  [switch] $Publish,
  [string] $Notes,
  # Reuse the Flutter build already in build\windows (saves the long build
  # while trying installer changes).
  [switch] $SkipFlutter
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'dist\installers'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Never change an AppGuid: Windows would treat the next installer as another
# program and a till would end up with two copies.
$catalogue = @{
  till    = @{ Dir = 'vesopa_epos';         Exe = 'vesopa_epos.exe';         Name = 'Vesopa EPOS';             Base = 'VesopaEPOS';     Guid = '5CAF3FB6-C9C0-4C8A-94C6-A34F546ABAEB'; Schemes = @('vesopa', 'com.vesopa.epos') }
  kitchen = @{ Dir = 'vesopa_epos_kitchen'; Exe = 'vesopa_epos_kitchen.exe'; Name = 'Vesopa Kitchen';          Base = 'VesopaKitchen';  Guid = '95F2A269-B4C5-48F2-AB20-068537FCDC36'; Schemes = @() }
  display = @{ Dir = 'vesopa_epos_display'; Exe = 'vesopa_epos_display.exe'; Name = 'Vesopa Customer Display'; Base = 'VesopaDisplay';  Guid = '4496EB8F-C186-4DF6-9E05-65FEFAEBE7FA'; Schemes = @('com.vesopa.display') }
  express = @{ Dir = 'vesopa_express';      Exe = 'vesopa_express.exe';      Name = 'Vesopa Express';          Base = 'VesopaExpress';  Guid = '93AA0941-FC80-400B-AD47-1D5974822FBD'; Schemes = @() }
  loyalty = @{ Dir = 'vesopa_loyalty';      Exe = 'vesopa_loyalty.exe';      Name = 'Vesopa Loyalty';          Base = 'VesopaLoyalty';  Guid = '8F0E1C84-0ABA-493F-AD2B-D06C66798038'; Schemes = @() }
}

# Windows PowerShell 5.1 turns a native program's stderr into an error; the
# exit code is what says whether it worked (see vesopa_epos\tool\build-store-msix.ps1).
function Invoke-Native {
  param([Parameter(Mandatory)] [scriptblock] $Command, [Parameter(Mandatory)] [string] $What)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$What failed with $LASTEXITCODE" }
}

# KEY=VALUE files, without printing anything. The first file to set a key wins,
# and a variable already in the environment beats both.
foreach ($file in '.env.claude-tools', '.env.claude') {
  $path = Join-Path $root $file
  if (-not (Test-Path $path)) { continue }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$') {
      $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($k)) { [Environment]::SetEnvironmentVariable($k, $v) }
    }
  }
}

$canSign = $env:TRUSTED_SIGNING_ENDPOINT -and $env:TRUSTED_SIGNING_ACCOUNT -and $env:TRUSTED_SIGNING_PROFILE -and
  $env:AZURE_TENANT_ID -and $env:AZURE_CLIENT_ID -and $env:AZURE_CLIENT_SECRET
if ($canSign) {
  if (-not (Get-Module -ListAvailable -Name TrustedSigning)) {
    Write-Host '==> Installing the TrustedSigning PowerShell module (once)' -ForegroundColor Cyan
    Install-Module -Name TrustedSigning -Scope CurrentUser -Force -AllowClobber
  }
  Import-Module TrustedSigning
} else {
  Write-Host 'Not signing: TRUSTED_SIGNING_* and AZURE_* are not all set. Installers will be unsigned.' -ForegroundColor Yellow
}

function Invoke-Sign([string[]] $Files) {
  if (-not $canSign) { return }
  Invoke-TrustedSigning -Endpoint $env:TRUSTED_SIGNING_ENDPOINT `
    -CodeSigningAccountName $env:TRUSTED_SIGNING_ACCOUNT `
    -CertificateProfileName $env:TRUSTED_SIGNING_PROFILE `
    -Files ($Files -join ',') -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256
}

# Inno Setup 6 or 7, wherever winget or its own installer put it.
$iscc = @(Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source) +
  @("$env:ProgramFiles", "${env:ProgramFiles(x86)}", "$env:LOCALAPPDATA\Programs" | Where-Object { $_ } |
    ForEach-Object { Get-ChildItem -Path (Join-Path $_ 'Inno Setup *\ISCC.exe') -ErrorAction SilentlyContinue } |
    Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName) |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup is not installed. Run: winget install JRSoftware.InnoSetup' }

$built = @()
foreach ($key in $Apps) {
  $a = $catalogue[$key]
  $dir = Join-Path $root $a.Dir
  $pubspec = Get-Content (Join-Path $dir 'pubspec.yaml') -Raw
  if ($pubspec -notmatch '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)') { throw "$($a.Dir)\pubspec.yaml has no version" }
  $version = $Matches[1]
  # The Store build's arguments (pubspec msix_config windows_build_args), so the
  # two copies of a version are the same program.
  $buildArgs = @('build', 'windows', '--release')
  if ($pubspec -match '(?m)^\s*windows_build_args:\s*(.+)$') {
    $buildArgs = @('build', 'windows') + ($Matches[1].Trim() -split '\s+' | Where-Object { $_ })
  }
  Write-Host "==> $($a.Name) $version" -ForegroundColor Cyan

  Push-Location $dir
  try {
    if (-not $SkipFlutter) { Invoke-Native { & flutter @buildArgs } "flutter build windows ($key)" }
  } finally { Pop-Location }
  $release = Join-Path $dir 'build\windows\x64\runner\Release'
  if (-not (Test-Path (Join-Path $release $a.Exe))) { throw "No $($a.Exe) in $release" }

  # The program first, so Windows names Vesopa when it runs, then the installer.
  Invoke-Sign @(Join-Path $release $a.Exe)

  $defines = @(
    "/DAppKey=$key", "/DAppName=$($a.Name)", "/DAppVersion=$version", "/DAppGuid=$($a.Guid)",
    "/DExeName=$($a.Exe)", "/DSourceDir=$release", "/DOutputDir=$out",
    "/DOutputBase=$($a.Base)-Setup-$version", "/DIconFile=$(Join-Path $dir 'windows\runner\resources\app_icon.ico')"
  )
  for ($i = 0; $i -lt $a.Schemes.Count; $i++) { $defines += "/DScheme$($i + 1)=$($a.Schemes[$i])" }
  Invoke-Native { & $iscc /Q @defines (Join-Path $root 'installer\vesopa-app.iss') } "Inno Setup ($key)"

  $setup = Join-Path $out "$($a.Base)-Setup-$version.exe"
  Invoke-Sign @($setup)
  $signed = (Get-AuthenticodeSignature $setup).Status -eq 'Valid'
  $mb = '{0:N1}' -f ((Get-Item $setup).Length / 1MB)
  Write-Host "    $setup ($mb MB, $(if ($signed) { 'signed' } else { 'unsigned' }))" -ForegroundColor Green
  $built += [pscustomobject]@{ App = $key; Version = $version; File = $setup; Signed = $signed }
}

if ($Publish) {
  foreach ($b in $built) {
    $pyArgs = @('tool/publish_installers.py', $b.App, $b.Version, $b.File)
    if ($b.Signed) { $pyArgs += '--signed' }
    if ($Notes) { $pyArgs += @('--notes', $Notes) }
    Push-Location $root
    try { Invoke-Native { & python @pyArgs } "publishing $($b.App) $($b.Version)" } finally { Pop-Location }
  }
  Write-Host ''
  Write-Host 'Done. Download them at https://admin.vesopa.com/downloads' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Built in $out. Add -Publish to put them on admin.vesopa.com/downloads." -ForegroundColor Green
}

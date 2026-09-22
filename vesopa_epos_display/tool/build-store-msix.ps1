<#
.SYNOPSIS
  Builds the Microsoft Store package for the customer display, with a taskbar
  icon that matches its neighbours.

.DESCRIPTION
  The same two-step build the till uses, and for the same reason: `msix` scales
  the brand master to fill every canvas, so the taskbar gets a solid green
  square edge to edge where every other app draws a glyph with a margin. See
  tool/pad_taskbar_icons.dart for why that cannot be fixed by padding the master
  — the same master is the Start tile, where full bleed is right.

  Unpacking and repacking is safe because a Store package is unsigned:
  Microsoft signs it on ingestion, so there is no signature to invalidate. The
  repack is what regenerates AppxBlockMap.xml, which is why the icon files
  cannot simply be swapped inside the zip.

.EXAMPLE
  pwsh tool/build-store-msix.ps1
#>
[CmdletBinding()]
param(
  # Skip straight to the icon fix and repack, reusing the package already built.
  [switch] $RepackOnly
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # msix writes to the release folder by default for this app; the till pins an
  # output_path because it has a history of stale packages reaching Partner
  # Center. This one has no such history yet, so it takes the default and the
  # path is resolved rather than assumed.
  $package = Get-ChildItem -Path (Join-Path $root 'build') -Filter '*.msix' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName

  if (-not $RepackOnly) {
    Write-Host '==> Building the Store package' -ForegroundColor Cyan
    & dart run msix:create --store
    if ($LASTEXITCODE -ne 0) { throw "msix:create failed with $LASTEXITCODE" }

    $package = Get-ChildItem -Path (Join-Path $root 'build') -Filter '*.msix' -Recurse |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  }

  if (-not $package) { throw 'No .msix found under build\.' }

  $makeappx = Get-ChildItem `
      'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe' `
      -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $makeappx) {
    throw 'makeappx.exe not found. Install the Windows 10/11 SDK.'
  }

  $staging = Join-Path $root 'build\msix-unpacked'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }

  Write-Host '==> Unpacking' -ForegroundColor Cyan
  & $makeappx unpack /p $package /d $staging /o /nv
  if ($LASTEXITCODE -ne 0) { throw "makeappx unpack failed with $LASTEXITCODE" }

  Write-Host '==> Padding the taskbar icons' -ForegroundColor Cyan
  & dart run tool/pad_taskbar_icons.dart (Join-Path $staging 'Images')
  if ($LASTEXITCODE -ne 0) { throw "padding the icons failed with $LASTEXITCODE" }

  # The block map describes contents that are about to change; makeappx rebuilds
  # it. The signature is absent from a Store package and is removed defensively
  # so a signed one cannot be repacked into something claiming a signature it no
  # longer has.
  foreach ($stale in 'AppxBlockMap.xml', 'AppxSignature.p7x', '[Content_Types].xml') {
    $path = Join-Path $staging $stale
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }

  Write-Host '==> Packing' -ForegroundColor Cyan
  Remove-Item $package -Force
  & $makeappx pack /d $staging /p $package /o /nv
  if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed with $LASTEXITCODE" }

  Remove-Item $staging -Recurse -Force

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $package))
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'AppxManifest.xml' }
    $reader = [IO.StreamReader]::new($entry.Open())
    $identity = [regex]::Match($reader.ReadToEnd(), '<Identity.*?/>', 'Singleline').Value
    $reader.Close()
  } finally {
    $zip.Dispose()
  }

  Write-Host ''
  Write-Host "Wrote $package" -ForegroundColor Green
  Write-Host $identity
} finally {
  Pop-Location
}

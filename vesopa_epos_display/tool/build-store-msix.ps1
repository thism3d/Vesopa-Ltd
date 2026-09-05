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

# ---------------------------------------------------------------------------
# Running a native program without mistaking its chatter for a failure
# ---------------------------------------------------------------------------
#
# Windows PowerShell 5.1 turns anything a native program writes to stderr into
# an ErrorRecord, and with $ErrorActionPreference = 'Stop' that is a terminating
# error even when the program exited 0. `dart run` prints "Running build
# hooks..." to stderr, which killed this script after the package had already
# been built — leaving the icons unpadded and a staging folder behind.
#
# The exit code is what actually says whether a step worked, and it is still
# checked. This only stops the noise being fatal. Harmless under PowerShell 7,
# where the behaviour never applied.
function Invoke-Native {
  param(
    [Parameter(Mandatory)] [scriptblock] $Command,
    [Parameter(Mandatory)] [string] $What
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "$What failed with $LASTEXITCODE" }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # One fixed path, pinned in pubspec.yaml, exactly as the till pins its own.
  #
  # This used to search build\ for the newest *.msix, which is how a stale
  # package reaches Partner Center: the newest file is not reliably the one this
  # run produced — a failed build leaves the previous one in place and newer
  # than nothing. The till already learned that lesson the expensive way and its
  # pubspec carries a long note about it. There is no reason for this one to
  # learn it separately.
  $package = Join-Path $root 'build\store\vesopa-display-store.msix'

  if (-not $RepackOnly) {
    Write-Host '==> Building the Store package' -ForegroundColor Cyan
    Invoke-Native { & dart run msix:create --store } 'msix:create'
  }

  if (-not (Test-Path $package)) { throw "No package at $package" }

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
  Invoke-Native { & $makeappx unpack /p $package /d $staging /o /nv } 'makeappx unpack'

  Write-Host '==> Padding the taskbar icons' -ForegroundColor Cyan
  $images = Join-Path $staging 'Images'
  Invoke-Native { & dart run tool/pad_taskbar_icons.dart $images } 'padding the icons'

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
  Invoke-Native { & $makeappx pack /d $staging /p $package /o /nv } 'makeappx pack'

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

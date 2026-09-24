<#
.SYNOPSIS
  Turn the Microsoft Store's automatic app updates off (or back on) on this till.

.DESCRIPTION
  "Can we stop the tills from automatically updating? Updates should require
  manual approval before they are installed."

  Two halves make that true:

    1. Vesopa's releases are published MANUALLY (ms-store-submission-client,
       PUBLISH_MODE defaults to Manual): Microsoft certifies a release and it
       then waits until somebody presses "Publish now" in Partner Center, after
       testing it on the office till. Until then no till anywhere can see it.

    2. This script, for a venue that also wants each till to wait for a person:
       it sets the Windows policy that stops the Store downloading and
       installing app updates by itself on this machine. Updates are then taken
       from the till's About page ("Check for updates"), which opens the Store.

  Run it in PowerShell opened as Administrator. The policy is honoured on
  Windows 10/11 Pro, Enterprise and Education; Windows Home ignores it (the
  Store's own settings can then only pause updates, not stop them).

.EXAMPLE
  .\till-updates.ps1 off      # the Store no longer updates apps by itself
  .\till-updates.ps1 on       # back to automatic updates
  .\till-updates.ps1          # say what it is set to now
#>
param(
  [ValidateSet('off', 'on', 'status')]
  [string]$Set = 'status'
)

$key = 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore'
$name = 'AutoDownload'   # 2 = automatic updates off, 4 = on (Microsoft's values)

function Show-State {
  $value = (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name
  switch ($value) {
    2 { 'Store automatic updates are OFF on this till. Update from the till''s About page.' }
    4 { 'Store automatic updates are ON (set by this script).' }
    default { 'Store automatic updates follow the Store''s own setting (no policy set).' }
  }
}

if ($Set -eq 'status') { Show-State; return }

$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Error 'Run PowerShell as Administrator: this changes a machine-wide Windows policy.'
  exit 1
}

if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
$value = if ($Set -eq 'off') { 2 } else { 4 }
Set-ItemProperty -Path $key -Name $name -Value $value -Type DWord
Show-State

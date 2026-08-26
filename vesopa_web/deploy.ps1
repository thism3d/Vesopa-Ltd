<#
.SYNOPSIS
  vesopaepos.com — one-command deploy from a Windows machine.

.DESCRIPTION
  The Windows counterpart to deploy.sh, and the same shape as
  vesopa_server/deploy.ps1. Two things deploy.sh relies on do not exist here:

    * rsync         — not on Windows. This uses a tar stream over scp instead.
    * ControlMaster — Windows OpenSSH does not multiplex, so this batches the
                      whole run into exactly TWO connections and you type the
                      password twice.

  ONE DIFFERENCE THAT MATTERS, and it is the same one the back office's script
  carries: deploy.sh syncs with `rsync --delete`, so a file deleted locally is
  deleted on the server. A tar stream cannot do that, so this script OVERWRITES
  and ADDS but never DELETES. If you have removed a file and need it gone from
  live, delete it on the server by hand.

  What is never touched, matching deploy.sh's excludes:
    .env / .env.*      the LIVE database credentials and mail secrets
    public/uploads     blog images and anything uploaded through the admin
    public/app         the installers — hundreds of megabytes that live only
                       on the server and would be re-uploaded on every deploy
    public/downloads   the same
    backup             the on-server backup directory
    node_modules, .git, *.log

  Nothing here touches the database. This site shares `vesopa_eposdb` with the
  till and the back office, and the tables it owns are created by hand — see
  SITE_TABLES in deploy.sh. A schema switch is deliberately not offered.

.PARAMETER RestartOnly
  Just restart pm2. No file changes.

.PARAMETER Logs
  Tail the live logs and exit.

.EXAMPLE
  .\deploy.ps1
  .\deploy.ps1 -Logs

.NOTES
  The password is never stored in this file. You are prompted for it.
  For automation, set $env:VESOPA_SSH_PASSWORD before running; the script then
  feeds it to ssh through a temporary SSH_ASKPASS helper which it deletes on
  exit. Prefer an SSH key over either.
#>
[CmdletBinding()]
param(
  [switch]$RestartOnly,
  [switch]$Logs
)

$ErrorActionPreference = 'Stop'

# ---- Config (mirrors deploy.sh) -------------------------------------------
$Server    = 'root@3.72.113.21'
$Domain    = 'vesopaepos.com'
$RemoteApp = if ($env:REMOTE_APP) { $env:REMOTE_APP } else { "/home/vesopa/web/$Domain/private/nodeapp" }
$Pm2App    = 'vesopa_web'
$HealthUrl = "https://$Domain/health"
$LocalApp  = $PSScriptRoot

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

function Step($m) { Write-Host "> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "OK $m"  -ForegroundColor Green }
function Warn($m) { Write-Host "!  $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "X  $m"  -ForegroundColor Red; exit 1 }

Write-Host "Vesopa website deploy -> $Server" -ForegroundColor Cyan
Write-Host "$Domain | $RemoteApp | pm2:$Pm2App"

# ---- SSH, with the password out of sight ----------------------------------
$SshOpts = @('-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15')
$Askpass = $null

if ($env:VESOPA_SSH_PASSWORD) {
  Warn 'Using VESOPA_SSH_PASSWORD from the environment.'
  # A one-line helper that echoes the password. ssh runs it instead of asking
  # at the terminal. Written to the user's temp directory, never into the repo,
  # and removed in the finally block below whatever happens.
  $Askpass = Join-Path ([IO.Path]::GetTempPath()) "vesopa-web-askpass-$Stamp.cmd"
  Set-Content -Path $Askpass -Value "@echo off`r`necho %VESOPA_SSH_PASSWORD%" -Encoding ascii
  $env:SSH_ASKPASS = $Askpass
  $env:SSH_ASKPASS_REQUIRE = 'force'
  $env:DISPLAY = 'vesopa'
}

function Invoke-Remote([string]$Script) {
  & ssh @SshOpts $Server $Script
  if ($LASTEXITCODE -ne 0) { Die "Remote command failed (exit $LASTEXITCODE)." }
}

try {
  if ($Logs) {
    Invoke-Remote "pm2 logs $Pm2App --lines 120"
    exit 0
  }

  if ($RestartOnly) {
    Step 'Restarting pm2...'
    Invoke-Remote "pm2 restart $Pm2App --update-env && pm2 save"
    Ok 'Restarted'
    exit 0
  }

  # ---- Pack ---------------------------------------------------------------
  Step 'Packing the site (excluding secrets, uploads and installers)...'
  Push-Location $LocalApp
  try {
    # bsdtar ships with Windows 10+. The excludes are deploy.sh's, one for one:
    # everything here either exists only on the server (.env), or is content a
    # deploy must never overwrite (public/uploads), or is far too large to send
    # every time (public/app).
    $Tarball = Join-Path ([IO.Path]::GetTempPath()) "vesopa-web-$Stamp.tar.gz"
    & tar -czf $Tarball `
      --exclude './.git' `
      --exclude './node_modules' `
      --exclude './.env' `
      --exclude './.env.*' `
      --exclude './backup' `
      --exclude './public/uploads' `
      --exclude './public/app' `
      --exclude './public/downloads' `
      --exclude '*.log' `
      --exclude '.DS_Store' `
      .
    if ($LASTEXITCODE -ne 0) { Die 'tar failed.' }
  } finally {
    Pop-Location
  }
  $Size = [math]::Round((Get-Item $Tarball).Length / 1KB)
  Ok "Packed ($Size KB)"

  # ---- Upload -------------------------------------------------------------
  Step 'Uploading... (password prompt 1 of 2)'
  & scp @SshOpts $Tarball "${Server}:/tmp/"
  if ($LASTEXITCODE -ne 0) { Die 'scp failed.' }
  Ok 'Uploaded'

  $remoteName = Split-Path $Tarball -Leaf

  # ---- Deploy -------------------------------------------------------------
  Step 'Deploying on the server... (password prompt 2 of 2)'
  $remote = @"
set -e
APP='$RemoteApp'
test -d "`$APP" || { echo "X Remote path not found: `$APP"; exit 1; }

echo '> Backing up the current code first...'
mkdir -p "`$APP/backup"
tar -czf "`$APP/backup/code_pre_deploy_$Stamp.tar.gz" --exclude=./node_modules --exclude=./backup --exclude=./public/uploads --exclude=./public/app -C "`$APP" . 2>/dev/null || true
echo "OK Backup -> backup/code_pre_deploy_$Stamp.tar.gz"

echo '> Extracting...'
tar -xzf '/tmp/$remoteName' -C "`$APP"
rm -f /tmp/vesopa-web-*.tar.gz
echo 'OK Code updated'

echo '> npm install...'
cd "`$APP"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --production --no-audit --no-fund >/dev/null 2>&1
echo 'OK Dependencies installed'

echo '> Restarting pm2...'
pm2 restart '$Pm2App' --update-env
pm2 save >/dev/null 2>&1 || true
"@
  Invoke-Remote $remote
  Ok 'Restarted'

  # ---- Health -------------------------------------------------------------
  Step 'Health check...'
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 25 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Ok "Website healthy: $HealthUrl" }
    else { Warn "Health check answered $($r.StatusCode)." }
  } catch {
    Warn "Health check did not answer: $($_.Exception.Message)"
  }

  Ok 'Deploy finished.'
  Write-Host "Live: https://$Domain"
} finally {
  # The askpass helper holds nothing itself — it echoes an environment variable
  # — but it exists only for the length of this run and is removed even when the
  # run fails.
  if ($Askpass -and (Test-Path $Askpass)) { Remove-Item $Askpass -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:\SSH_ASKPASS, Env:\SSH_ASKPASS_REQUIRE, Env:\DISPLAY -ErrorAction SilentlyContinue
  if (Test-Path variable:Tarball) { Remove-Item $Tarball -Force -ErrorAction SilentlyContinue }
}

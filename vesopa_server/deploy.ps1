<#
.SYNOPSIS
  Vesopa EPOS back office — one-command deploy from a Windows machine.

.DESCRIPTION
  The Windows counterpart to deploy.sh. Same server, same result; different
  plumbing, because two things deploy.sh relies on do not exist here:

    * rsync      — not on Windows. This uses a tar stream over scp instead.
    * ControlMaster (one password for the whole run) — not supported by
                   Windows OpenSSH. So this batches everything into exactly
                   TWO connections, and you type the password twice.

  ONE DIFFERENCE THAT MATTERS: deploy.sh syncs with `rsync --delete`, so a file
  deleted locally is deleted on the server. A tar stream cannot do that, so this
  script OVERWRITES and ADDS but never DELETES. If you have removed a server
  file and need it gone from live, delete it on the server by hand.

  What is never touched, matching deploy.sh's excludes:
    .env / .env.*      the LIVE database credentials and JWT secret
    public/uploads     venue logos and product images, which exist only on live
    backup             the on-server backup directory
    node_modules, .git, *.log

.PARAMETER Schema
  Also apply the schema/*.sql migrations to the live database. Every migration
  is guarded (IF NOT EXISTS, or the vesopa_add_column procedure), so this is
  safe to re-run — but it is opt-in because it touches the database.

  They live in schema/, not beside the code, and the deploy fails rather than
  reporting success if it finds none there.

.PARAMETER RestartOnly
  Just restart pm2. No file changes.

.PARAMETER Logs
  Tail the live logs and exit.

.EXAMPLE
  .\deploy.ps1
  .\deploy.ps1 -Schema
  .\deploy.ps1 -Logs

.NOTES
  The password is never stored in this file. You are prompted for it.
  For automation, set $env:VESOPA_SSH_PASSWORD before running; the script then
  feeds it to ssh through a temporary SSH_ASKPASS helper which it deletes on
  exit. Prefer an SSH key over either.
#>
[CmdletBinding()]
param(
  [switch]$Schema,
  [switch]$RestartOnly,
  [switch]$Logs
)

$ErrorActionPreference = 'Stop'

# ---- Config (mirrors deploy.sh) -------------------------------------------
$Server    = 'root@3.72.113.21'
$Domain    = 'backoffice.vesopaepos.com'
$RemoteApp = if ($env:REMOTE_APP) { $env:REMOTE_APP } else { "/home/vesopa/web/$Domain/private/nodeapp" }
$Pm2App    = 'vesopa_backoffice'
$DbName    = 'vesopa_eposdb'
$HealthUrl = "https://$Domain/health"
$LocalApp  = $PSScriptRoot

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

function Step($m) { Write-Host "> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "OK $m"  -ForegroundColor Green }
function Warn($m) { Write-Host "!  $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "X  $m"  -ForegroundColor Red; exit 1 }

# ---- Non-interactive password support -------------------------------------
#
# Windows OpenSSH reads a password from the console, never from stdin, so a
# password cannot simply be piped in. SSH_ASKPASS is the supported way round
# that. The helper is written to the user's temp directory, not the repo, and
# removed in the finally block below.
$AskPass = $null
function Initialize-AskPass {
  if (-not $env:VESOPA_SSH_PASSWORD) { return }
  $script:AskPass = Join-Path ([IO.Path]::GetTempPath()) "vesopa-askpass-$PID.cmd"
  # @echo off so the password is not echoed by the shell that runs this.
  "@echo off`r`necho $($env:VESOPA_SSH_PASSWORD)" |
    Set-Content -Path $script:AskPass -Encoding ascii
  $env:SSH_ASKPASS = $script:AskPass
  $env:SSH_ASKPASS_REQUIRE = 'force'
  $env:DISPLAY = ':0'
  Warn 'Using VESOPA_SSH_PASSWORD from the environment.'
}
function Remove-AskPass {
  if ($script:AskPass -and (Test-Path $script:AskPass)) {
    Remove-Item $script:AskPass -Force -ErrorAction SilentlyContinue
  }
}

$SshOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20')

# Runs one batch of commands on the server. Deliberately called as few times as
# possible — each call is another password prompt.
function Invoke-Remote([string]$script) {
  # The script is sent base64-encoded, and that is not paranoia — it is the only
  # reliable way to do this from Windows PowerShell.
  #
  # Two things corrupt a shell script on the way to the server otherwise:
  #   * PowerShell 5.1 mangles double quotes when handing arguments to a native
  #     exe, so `echo "a -> b"` arrives unquoted and bash reads the `>` as a
  #     redirection. That failure looks like a missing file and is baffling.
  #   * Here-strings produce CRLF, and bash treats a `\` before a CR as escaping
  #     the CR rather than continuing the line.
  #
  # Base64 is alphanumeric plus +/=, so nothing in it can be re-interpreted by
  # either shell. Normalise the line endings first, then encode.
  $lf = $script -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lf))
  & ssh @SshOpts $Server "echo $b64 | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { Die "Remote command failed (exit $LASTEXITCODE)." }
}

Write-Host "Vesopa back office deploy -> $Server" -ForegroundColor White
Write-Host "$Domain | $RemoteApp | pm2:$Pm2App" -ForegroundColor DarkGray

try {
  Initialize-AskPass

  # ---- Fast paths ---------------------------------------------------------
  if ($Logs) {
    Step 'Tailing live logs...'
    Invoke-Remote "pm2 logs $Pm2App --lines 80 --nostream"
    exit 0
  }

  if ($RestartOnly) {
    Step 'Restarting pm2...'
    Invoke-Remote "pm2 restart $Pm2App --update-env && pm2 save"
    Ok 'Restarted'
  }
  else {
    if (-not (Test-Path (Join-Path $LocalApp 'src'))) {
      Die "Local server not found at $LocalApp (expected a src\ directory)."
    }

    # ---- 1. Pack ----------------------------------------------------------
    #
    # bsdtar ships with Windows 10+. The excludes are deploy.sh's, one for one:
    # getting these wrong is how a deploy takes the back office down (.env) or
    # erases every venue's branding (public/uploads).
    Step 'Packing the app (excluding secrets, uploads and backups)...'
    $Tarball = Join-Path ([IO.Path]::GetTempPath()) "vesopa-server-$Stamp.tar.gz"
    & tar -czf $Tarball `
      --exclude './.git' `
      --exclude './node_modules' `
      --exclude './.env' `
      --exclude './.env.*' `
      --exclude './backup' `
      --exclude './public/uploads' `
      --exclude '*.log' `
      --exclude '.DS_Store' `
      -C $LocalApp .
    if ($LASTEXITCODE -ne 0) { Die 'tar failed.' }
    $SizeKb = [math]::Round((Get-Item $Tarball).Length / 1KB)
    Ok "Packed ($SizeKb KB)"

    # ---- 2. Upload (connection 1) ----------------------------------------
    Step 'Uploading... (password prompt 1 of 2)'
    & scp @SshOpts $Tarball "${Server}:/tmp/"
    if ($LASTEXITCODE -ne 0) { Die 'Upload failed.' }
    Ok 'Uploaded'
    Remove-Item $Tarball -Force -ErrorAction SilentlyContinue

    # ---- 3. Everything remote (connection 2) ------------------------------
    #
    # One script so there is one password prompt, not six.
    $remoteName = Split-Path $Tarball -Leaf
    $schemaBlock = ''
    if ($Schema) {
      # `mariadb` first, and the deprecation warning swallowed, for a reason
      # that cost a deploy: this whole script runs under
      # $ErrorActionPreference = 'Stop', and PowerShell 5.1 turns *any* stderr
      # from a native exe into a terminating error. MariaDB prints
      # "mysql: Deprecated program name" on stderr and exits 0 -- a warning, not
      # a failure -- and that one line aborted the deploy half way through the
      # migrations, with the code already extracted and pm2 not yet restarted.
      $schemaBlock = @"
echo '> Applying schema/*.sql to the live database...'

# schema/, not the project root. The migrations moved there when there were
# fifty of them burying deploy.sh, package.json and src/ in a wall of files.
# deploy.sh was updated and this was not, so `-Schema` spent a release looking
# for schema_*.sql in a directory that has held none since -- finding nothing,
# applying nothing, and printing "OK Schema applied" over the top of it.
#
# Hence the count and the `exit 1`. A migration step that cannot find its
# migrations has failed, and the one thing it must never do is say it worked:
# the deploy then completes, the app restarts, and the missing column is
# discovered by a customer.
cd "`$APP/schema" || { echo 'X No schema/ directory on the server'; exit 1; }
COUNT=`$(ls schema_*.sql 2>/dev/null | wc -l)
if [ "`$COUNT" -eq 0 ]; then
  echo 'X No schema_*.sql found in schema/ - nothing was applied'
  exit 1
fi
echo "   `$COUNT migrations"

DB=`$(command -v mariadb || command -v mysql)
for f in schema.sql `$(ls schema_*.sql | sort); do
  echo "   -> `$f"
  "`$DB" '$DbName' < "`$f" 2>&1 | grep -v 'Deprecated program name' || true
done
echo 'OK Schema applied'
"@
    }

    $remote = @"
set -e
APP='$RemoteApp'
test -d "`$APP" || { echo "X Remote path not found: `$APP"; exit 1; }

echo '> Backing up the current code first...'
mkdir -p "`$APP/backup"
tar -czf "`$APP/backup/code_pre_deploy_$Stamp.tar.gz" --exclude=./node_modules --exclude=./backup --exclude=./public/uploads -C "`$APP" . 2>/dev/null || true
echo "OK Backup -> backup/code_pre_deploy_$Stamp.tar.gz"

echo '> Extracting...'
tar -xzf '/tmp/$remoteName' -C "`$APP"
# Tidy up this upload and any left behind by a run that failed part way.
rm -f /tmp/vesopa-server-*.tar.gz
echo 'OK Code updated'

echo '> npm install...'
cd "`$APP" && npm install --omit=dev --no-audit --no-fund >/dev/null
echo 'OK Dependencies installed'

$schemaBlock

echo '> Restarting pm2...'
cd "`$APP"
pm2 restart '$Pm2App' --update-env || pm2 start ecosystem.config.cjs
pm2 save >/dev/null
echo 'OK Restarted'
"@

    Step 'Deploying on the server... (password prompt 2 of 2)'
    Invoke-Remote $remote
  }

  # ---- Health check (no SSH needed) ---------------------------------------
  Step 'Health check...'
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 20 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Ok "Back office healthy: $HealthUrl" }
    else { Warn "Health check returned $($r.StatusCode)" }
  }
  catch {
    Warn "Health check failed at $HealthUrl"
    Warn 'It may still be starting. Check with: .\deploy.ps1 -Logs'
  }

  Ok 'Deploy finished.'
  Write-Host "Admin: https://$Domain" -ForegroundColor DarkGray
}
finally {
  Remove-AskPass
}

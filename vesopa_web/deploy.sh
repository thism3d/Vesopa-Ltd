#!/usr/bin/env bash
#
# vesopaepos.com — one-command deploy from your Mac to the live server.
#
#   ./deploy.sh                 Deploy the site, then restart pm2.
#   ./deploy.sh --schema        ALSO apply every schema*.sql to the live DB.
#                               Every statement is guarded, so it is safe to
#                               re-run, but it is opt-in because it touches the
#                               database.
#   ./deploy.sh --db-push       ALSO overwrite the LIVE enquiry/admin tables with
#                               your LOCAL ones. DESTRUCTIVE: backs live up first,
#                               then asks you to type "yes".
#   ./deploy.sh --db-pull       Copy the LIVE tables down to your LOCAL database.
#                               DESTRUCTIVE to your local DB only. Backs it up first.
#   ./deploy.sh --restart-only  Just restart pm2 (no code changes).
#   ./deploy.sh --logs          Tail the live logs and exit.
#   ./deploy.sh --help
#
# There is no build step: pages are server-rendered EJS and the browser assets
# are plain CSS and vanilla JS served straight out of public/. A deploy is
# rsync + npm install + pm2 restart, and nothing else.
#
# You type the SSH password ONCE — the script keeps a single multiplexed SSH
# connection open for the whole run. The password is never stored in this file.
#
set -euo pipefail

# ---- Config ---------------------------------------------------------------
SERVER="root@3.72.113.21"
DOMAIN="vesopaepos.com"

# Where the app lives on the server. Override without editing this file:
#   REMOTE_APP=/some/other/path ./deploy.sh
REMOTE_APP="${REMOTE_APP:-/home/vesopa/web/$DOMAIN/private/nodeapp}"
REMOTE_BACKUP="$REMOTE_APP/backup"

LOCAL_APP="/Users/onzep/development/Vesopa/vesopa_web"
LOCAL_BACKUP="$LOCAL_APP/backup"

# From ecosystem.config.cjs — must match, or pm2 starts a second copy alongside
# the running one and two processes fight over port 5065.
PM2_APP="vesopa_web"

DB_NAME="vesopa_eposdb"

# Only the tables this site owns. The till and back-office tables in the same
# database belong to vesopa_server and must never be moved by this script.
SITE_TABLES="demo_request customer_message career_request training_request \
backoffice_users admin_table paypal_subscriptions paypal_transactions"

HEALTH_URL="https://$DOMAIN/health"

# ---- Pretty output --------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

# ---- Args -----------------------------------------------------------------
DO_CODE=1; DO_SCHEMA=0; DO_DBPUSH=0; DO_DBPULL=0; RESTART_ONLY=0; DO_LOGS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --schema)        DO_SCHEMA=1 ;;
    --db-push)       DO_DBPUSH=1 ;;
    --db-pull)       DO_DBPULL=1; DO_CODE=0 ;;
    --restart-only)  RESTART_ONLY=1; DO_CODE=0 ;;
    --logs)          DO_LOGS=1; DO_CODE=0 ;;
    -h|--help)
      awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

[[ $DO_DBPUSH -eq 1 && $DO_DBPULL -eq 1 ]] && die "--db-push and --db-pull are opposites; pick one."

# ---- Local DB credentials, read from .env ---------------------------------
# The same file the server uses, so there is one place to change them. Only read
# when a DB operation was actually asked for.
read_local_env() {
  [[ -f "$LOCAL_APP/.env" ]] || die "No .env at $LOCAL_APP/.env — needed for local DB access."
  LOCAL_DB_HOST="$(grep -E '^DB_HOST=' "$LOCAL_APP/.env" | cut -d= -f2- | tr -d '"' | xargs)"
  LOCAL_DB_PORT="$(grep -E '^DB_PORT=' "$LOCAL_APP/.env" | cut -d= -f2- | tr -d '"' | xargs)"
  LOCAL_DB_USER="$(grep -E '^DB_USER=' "$LOCAL_APP/.env" | cut -d= -f2- | tr -d '"' | xargs)"
  LOCAL_DB_PASS="$(grep -E '^DB_PASSWORD=' "$LOCAL_APP/.env" | cut -d= -f2- | tr -d '"' | xargs)"
  LOCAL_DB_NAME="$(grep -E '^DB_NAME=' "$LOCAL_APP/.env" | cut -d= -f2- | tr -d '"' | xargs)"
  [[ -n "${LOCAL_DB_USER:-}" ]] || die "DB_USER missing from .env"
  LOCAL_DB_HOST="${LOCAL_DB_HOST:-127.0.0.1}"
  LOCAL_DB_PORT="${LOCAL_DB_PORT:-3306}"
  LOCAL_DB_NAME="${LOCAL_DB_NAME:-$DB_NAME}"
}

# ---- SSH multiplexing (password entered once) -----------------------------
CTRL="$HOME/.ssh/cm-vesopa-web.sock"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CTRL" -o ControlPersist=20m -o ConnectTimeout=15)
RSH="ssh ${SSH_OPTS[*]}"
R() { ssh "${SSH_OPTS[@]}" "$SERVER" "$@"; }

cleanup() { ssh -O exit -o "ControlPath=$CTRL" "$SERVER" 2>/dev/null || true; }
trap cleanup EXIT

TS="$(date +%Y%m%d_%H%M%S)"

echo "${BOLD}Vesopa EPOS website deploy → $SERVER${RST}"
echo "${DIM}$DOMAIN  ·  $REMOTE_APP  ·  pm2:$PM2_APP  ·  port 5065${RST}"

step "Connecting (you'll be asked for the SSH password once)…"
R "echo connected to \$(hostname) as \$(whoami)" || die "SSH connection failed"
ok "SSH connection established (reused for the whole run)"

# The remote path is a guess based on the hosting layout until it is confirmed
# once. Failing here with the real reason beats rsync silently creating a new
# tree that nginx never serves.
R "test -d '$REMOTE_APP'" || die \
  "Remote path not found: $REMOTE_APP
   Create it, or find the real one on the server (ls /home/vesopa/web/$DOMAIN/private/) and re-run as:
   REMOTE_APP=/that/path ./deploy.sh"

# ---- Logs fast path -------------------------------------------------------
if [[ $DO_LOGS -eq 1 ]]; then
  R "pm2 logs $PM2_APP --lines 80 --nostream"
  exit 0
fi

# ---- Restart-only fast path ----------------------------------------------
if [[ $RESTART_ONLY -eq 1 ]]; then
  step "Restarting pm2…"
  R "pm2 restart $PM2_APP --update-env"
  ok "Restarted"
  step "Health check…"
  sleep 2
  curl -fsS "$HEALTH_URL" && echo && ok "Healthy" || warn "Health check did not return OK"
  exit 0
fi

# ---- Rsync excludes (protect live secrets & uploads) ----------------------
EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store'
  # The live database credentials, SMTP password, session secret and PayPal
  # keys live here and are NOT the local ones. Overwriting this file takes the
  # whole site down.
  --exclude '.env' --exclude '.env.*'
  --exclude '*.log'
  --exclude 'backup'
  # The Windows installer and the Android APK the /download page links to are
  # uploaded to the server directly — they are build artefacts, far too large to
  # keep in this repo, and they change on their own release cadence.
  #
  # This exclude is load-bearing: the rsync above runs with --delete, so without
  # it every deploy would delete both files from the server and /download would
  # start 404ing. 'downloads' is the retired path, kept so an old deploy cannot
  # resurrect it.
  --exclude 'public/app'
  --exclude 'public/downloads'
  # Same reasoning for anything uploaded through /admin/files: blog cover
  # images, PDFs, screenshots. They only exist on the server, so --delete would
  # take every one of them with it and leave the pages linking at 404s.
  --exclude 'public/uploads'
)

# ---- DB pull (live → local) ----------------------------------------------
if [[ $DO_DBPULL -eq 1 ]]; then
  read_local_env
  warn "DB PULL will OVERWRITE these tables in your LOCAL '$LOCAL_DB_NAME':"
  warn "  $SITE_TABLES"
  read -r -p "${BOLD}Type 'yes' to continue: ${RST}" ans
  [[ "$ans" == "yes" ]] || die "Aborted."

  mkdir -p "$LOCAL_BACKUP"
  step "Backing up your LOCAL tables first…"
  MYSQL_PWD="$LOCAL_DB_PASS" mysqldump -h "$LOCAL_DB_HOST" -P "$LOCAL_DB_PORT" \
    -u "$LOCAL_DB_USER" --single-transaction "$LOCAL_DB_NAME" $SITE_TABLES \
    > "$LOCAL_BACKUP/local_pre_pull_$TS.sql" || die "Local backup failed"
  ok "Local backup → backup/local_pre_pull_$TS.sql"

  step "Dumping the LIVE tables…"
  R "mysqldump --single-transaction '$DB_NAME' $SITE_TABLES" > "$LOCAL_BACKUP/live_$TS.sql" \
    || die "Live dump failed"
  ok "Live dump pulled ($(du -h "$LOCAL_BACKUP/live_$TS.sql" | cut -f1))"

  step "Restoring onto your local database…"
  MYSQL_PWD="$LOCAL_DB_PASS" mysql -h "$LOCAL_DB_HOST" -P "$LOCAL_DB_PORT" \
    -u "$LOCAL_DB_USER" "$LOCAL_DB_NAME" < "$LOCAL_BACKUP/live_$TS.sql" \
    || die "Local restore failed"
  ok "Local tables now match live"
  exit 0
fi

# ---- Code deploy ----------------------------------------------------------
if [[ $DO_CODE -eq 1 ]]; then
  [[ -d "$LOCAL_APP/src" ]] || die "Local app not found: $LOCAL_APP"

  step "Syncing code → $REMOTE_APP"
  # --delete so files removed locally go away on the server too; everything that
  # must survive is excluded above.
  rsync -az --delete --stats -e "$RSH" "${EXCLUDES[@]}" \
    "$LOCAL_APP/" "$SERVER:$REMOTE_APP/"
  ok "Code synced"

  step "npm install on the server…"
  R "cd '$REMOTE_APP' && npm install --omit=dev --no-audit --no-fund" \
    || die "npm install failed"
  ok "Dependencies installed"
fi

# ---- Schema (opt-in) ------------------------------------------------------
if [[ $DO_SCHEMA -eq 1 ]]; then
  # Every schema file, not just schema.sql.
  #
  # This applied schema.sql alone, which meant schema_admin.sql — the /admin
  # panel's own tables and the backoffice_users.email collation fix — only ever
  # reached the server if someone remembered to run it by hand. Listing the
  # files means a new one is picked up by existing, rather than by being added
  # to a list here that nobody thinks to update.
  #
  # Sorted, so schema.sql lands before schema_admin.sql: the admin migration
  # adds columns to tables the base schema creates.
  for sql in $(ls "$LOCAL_APP"/schema*.sql | xargs -n1 basename | sort); do
    step "Applying $sql to the live database…"
    R "cd '$REMOTE_APP' && mysql '$DB_NAME' < '$sql'" || die "Applying $sql failed"
    ok "$sql applied"
  done
fi

# ---- DB push (DESTRUCTIVE, opt-in) ---------------------------------------
if [[ $DO_DBPUSH -eq 1 ]]; then
  read_local_env
  warn "DB PUSH will OVERWRITE these tables in the LIVE '$DB_NAME':"
  warn "  $SITE_TABLES"
  warn "Every enquiry, approval and payment recorded on live since your last sync will be LOST."
  read -r -p "${BOLD}Type 'yes' to continue: ${RST}" ans
  [[ "$ans" == "yes" ]] || die "Aborted DB push."

  mkdir -p "$LOCAL_BACKUP"
  local_dump="$LOCAL_BACKUP/site_local_$TS.sql"
  step "Dumping LOCAL tables → $(basename "$local_dump")"
  MYSQL_PWD="$LOCAL_DB_PASS" mysqldump -h "$LOCAL_DB_HOST" -P "$LOCAL_DB_PORT" \
    -u "$LOCAL_DB_USER" --single-transaction "$LOCAL_DB_NAME" $SITE_TABLES > "$local_dump" \
    || die "Local mysqldump failed"
  ok "Local dump created ($(du -h "$local_dump" | cut -f1))"

  step "Stopping the app before the restore…"
  R "pm2 stop $PM2_APP || true"

  step "Backing up the LIVE tables first (safety)…"
  R "mkdir -p '$REMOTE_BACKUP' && mysqldump --single-transaction '$DB_NAME' $SITE_TABLES \
     > '$REMOTE_BACKUP/site_LIVE_pre_restore_$TS.sql'" \
    && ok "Live tables backed up → site_LIVE_pre_restore_$TS.sql" \
    || die "Live pre-restore backup failed — refusing to overwrite live without one"

  step "Uploading and restoring…"
  rsync -az -e "$RSH" "$local_dump" "$SERVER:$REMOTE_BACKUP/"
  R "mysql '$DB_NAME' < '$REMOTE_BACKUP/$(basename "$local_dump")'" \
    || die "Restore failed — live tables may be half-written. Restore from
           $REMOTE_BACKUP/site_LIVE_pre_restore_$TS.sql"

  step "Verifying…"
  R "mysql -N -e \"SELECT CONCAT(COUNT(*),' demo requests') FROM $DB_NAME.demo_request;\""
  ok "Database push complete"
fi

# ---- Restart --------------------------------------------------------------
step "Restarting ${PM2_APP}…"
R "cd '$REMOTE_APP' && (pm2 restart $PM2_APP --update-env \
   || pm2 start ecosystem.config.cjs) && pm2 save" \
  || die "pm2 restart failed — check: ./deploy.sh --logs"
ok "Restarted"

# ---- Health check ---------------------------------------------------------
step "Health check…"
sleep 3
if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  ok "Site healthy: $HEALTH_URL"
else
  warn "Health check failed at $HEALTH_URL"
  warn "The app may still be starting. Check with: ./deploy.sh --logs"
fi

ok "${BOLD}Deploy finished.${RST}"
echo "${DIM}Site:  https://$DOMAIN${RST}"
echo "${DIM}Admin: https://$DOMAIN/admin${RST}"

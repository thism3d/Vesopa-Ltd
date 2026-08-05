#!/usr/bin/env bash
#
# hosting.vesopaepos.com — one-command deploy from your Mac to the live server.
#
#   ./deploy.sh                 Deploy the app, then restart pm2.
#   ./deploy.sh --schema        ALSO apply schema.sql and seed.sql to the live DB.
#                               Both are idempotent, but it is opt-in because it
#                               touches the database.
#   ./deploy.sh --seed-admin    ALSO run the admin bootstrap on the server.
#   ./deploy.sh --restart-only  Just restart pm2 (no code changes).
#   ./deploy.sh --logs          Tail the live logs and exit.
#   ./deploy.sh --help
#
# There is no build step: pages are server-rendered EJS and the browser assets
# are plain CSS and vanilla JS served straight out of public/.
#
# You type the SSH password ONCE — a single multiplexed connection is held open
# for the whole run. The password is never stored in this file.
#
set -euo pipefail

# ---- Config ---------------------------------------------------------------
SERVER="root@65.20.79.162"
DOMAIN="hosting.vesopaepos.com"

REMOTE_APP="${REMOTE_APP:-/home/vesopa/web/$DOMAIN/private/nodeapp}"
LOCAL_APP="/Users/onzep/development/Vesopa/vesopa_hosting"

# Must match ecosystem.config.cjs, or pm2 starts a second copy alongside the
# running one and two processes fight over port 5075.
PM2_APP="vesopa_hosting"

# NOT vesopa_eposdb. The hosting business shares the MySQL server with the EPOS
# apps but not the schema — see the note at the top of schema.sql.
DB_NAME="vesopa_hostingdb"

HEALTH_URL="https://$DOMAIN/robots.txt"

# ---- Pretty output --------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

# ---- Args -----------------------------------------------------------------
DO_SCHEMA=0; DO_SEED_ADMIN=0; RESTART_ONLY=0; LOGS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --schema)       DO_SCHEMA=1 ;;
    --seed-admin)   DO_SEED_ADMIN=1 ;;
    --restart-only) RESTART_ONLY=1 ;;
    --logs)         LOGS_ONLY=1 ;;
    --help|-h)      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown option: $arg" ;;
  esac
done

# ---- One SSH connection for the whole run ---------------------------------
CTL="/tmp/vh-deploy-$$.sock"
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=300)
cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$SERVER" 2>/dev/null || true; rm -f "$CTL"; }
trap cleanup EXIT

remote() { ssh "${SSH_OPTS[@]}" "$SERVER" "$@"; }

step "Connecting to $SERVER"
remote true || die "Could not connect."
ok "Connected."

# ---- Logs -----------------------------------------------------------------
if [[ $LOGS_ONLY -eq 1 ]]; then
  step "Tailing $PM2_APP (Ctrl-C to stop)"
  # --lines 50 rather than the default, so you land on enough context to see
  # what happened before the thing you came to look at.
  remote "pm2 logs $PM2_APP --lines 50"
  exit 0
fi

# ---- Restart only ---------------------------------------------------------
if [[ $RESTART_ONLY -eq 1 ]]; then
  step "Restarting $PM2_APP"
  remote "cd $REMOTE_APP && pm2 restart $PM2_APP --update-env"
  ok "Restarted."
  exit 0
fi

# ---- Sanity ---------------------------------------------------------------
[[ -f "$LOCAL_APP/package.json" ]] || die "Run this from a checkout at $LOCAL_APP"
[[ -f "$LOCAL_APP/.env" ]] || warn "No local .env — that is fine, the server keeps its own."

# ---- Push -----------------------------------------------------------------
step "Making sure $REMOTE_APP exists"
remote "mkdir -p $REMOTE_APP/logs"

step "Uploading"
# --delete keeps the server a mirror of the checkout, so a file deleted here is
# deleted there. The excludes matter enormously: without them this would wipe
# the server's own .env and its node_modules.
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'logs/' \
  --exclude 'public/uploads/' \
  --exclude '.DS_Store' \
  --exclude 'theme_purchased_from_codecanyon/' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$LOCAL_APP/" "$SERVER:$REMOTE_APP/"
ok "Uploaded."

step "Installing dependencies"
remote "cd $REMOTE_APP && npm install --omit=dev --no-audit --no-fund"
ok "Dependencies installed."

# ---- Schema ---------------------------------------------------------------
if [[ $DO_SCHEMA -eq 1 ]]; then
  step "Applying schema and catalogue to $DB_NAME"
  # The password is read from the app's own .env on the server rather than
  # passed on the command line, where it would appear in the process list.
  # MYSQL_PWD interacts badly with special characters across the SSH layer, so
  # --password="$VAR" it is.
  remote "cd $REMOTE_APP && \
    DBU=\$(grep -E '^DB_USER=' .env | cut -d= -f2-) && \
    DBP=\$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2-) && \
    mysql -u \"\$DBU\" --password=\"\$DBP\" -e 'CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;' && \
    mysql -u \"\$DBU\" --password=\"\$DBP\" $DB_NAME < schema.sql && \
    mysql -u \"\$DBU\" --password=\"\$DBP\" $DB_NAME < seed.sql" 2>&1 | grep -v 'insecure' || true
  ok "Schema applied."

  step "Verifying collations"
  # The one check worth making every time. A column that came back as
  # uca1400_ai_ci will silently match nothing on any join.
  remote "cd $REMOTE_APP && \
    DBU=\$(grep -E '^DB_USER=' .env | cut -d= -f2-) && \
    DBP=\$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2-) && \
    mysql -u \"\$DBU\" --password=\"\$DBP\" -N -e \"
      SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME,' = ',COLLATION_NAME)
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = '$DB_NAME'
         AND COLLATION_NAME IS NOT NULL
         AND COLLATION_NAME <> 'utf8mb4_general_ci';\"" 2>&1 | grep -v 'insecure' > /tmp/vh-collations.txt || true
  if [[ -s /tmp/vh-collations.txt ]]; then
    warn "Columns on the wrong collation — re-run --schema, the repair pass should fix them:"
    cat /tmp/vh-collations.txt
  else
    ok "Every column is utf8mb4_general_ci."
  fi
fi

# ---- Admin bootstrap ------------------------------------------------------
if [[ $DO_SEED_ADMIN -eq 1 ]]; then
  step "Seeding the admin account"
  remote "cd $REMOTE_APP && npm run seed:admin"
  warn "Now blank ADMIN_PASSWORD in the server's .env."
fi

# ---- Restart --------------------------------------------------------------
step "Restarting $PM2_APP"
# start-or-restart: the first deploy has nothing to restart, and `pm2 restart`
# on a name it does not know is an error rather than a no-op.
remote "cd $REMOTE_APP && (pm2 restart $PM2_APP --update-env || pm2 start ecosystem.config.cjs) && pm2 save" >/dev/null
ok "Running."

# ---- Health ---------------------------------------------------------------
step "Checking $HEALTH_URL"
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" || echo 000)
if [[ "$CODE" == "200" ]]; then
  ok "Live and answering."
else
  warn "Health check returned $CODE."
  warn "If this is the first deploy, nginx may not have a server block for $DOMAIN yet."
  echo "${DIM}  Recent logs:${RST}"
  remote "pm2 logs $PM2_APP --lines 25 --nostream" || true
fi

echo
ok "Done. ${DIM}https://$DOMAIN${RST}"

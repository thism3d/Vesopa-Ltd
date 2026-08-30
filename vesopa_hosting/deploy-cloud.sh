#!/usr/bin/env bash
#
# cloud.vesopa.com — deploy from this Mac to the Vesopa Cloud server.
#
#   ./deploy-cloud.sh                Sync the app and restart it.
#   ./deploy-cloud.sh --schema       ALSO apply schema.sql (idempotent, opt-in
#                                    because it touches the live database).
#   ./deploy-cloud.sh --restart-only Just restart pm2.
#   ./deploy-cloud.sh --logs         Tail the live logs and exit.
#   ./deploy-cloud.sh --brokers      ALSO install/refresh the three root brokers
#                                    (terminal, files, apps) and their units.
#
# WHY THIS EXISTS ALONGSIDE deploy.sh
# -----------------------------------
# `deploy.sh` targets the OLD box — root@3.72.113.21, hosting.vesopaepos.com —
# and has never been repointed. Running it does not deploy cloud.vesopa.com, and
# editing it to would silently break deploys of the site that still lives there.
# Two servers, two scripts.
#
# THE THREE THINGS THIS SERVER DOES DIFFERENTLY, each of which has cost an
# afternoon at least once:
#
#   pm2 IS PER USER. There is one daemon per Hestia account, as
#   `pm2-hestia@<user>.service`. Running pm2 as root starts a SECOND copy of the
#   app beside the running one and the two fight over the port. Everything here
#   goes through `su - vesopasoftware`.
#
#   `v-add-nodejs-app` REGENERATES .env with a two-line stub. It is idempotent
#   for the app and not for the environment: re-running it after a deploy has
#   wiped a 57-setting file and left the app crash-looping on a missing DB_USER.
#   Nothing here calls it, and the rsync below EXCLUDES .env for the same reason.
#
#   pm2 writes logs/out-0.log and logs/error-0.log, not the names in
#   ecosystem.config.js. `--logs` reads the right ones.
#
set -euo pipefail

SERVER="root@34.63.118.67"
DOMAIN="cloud.vesopa.com"
APP_USER="vesopasoftware"
REMOTE_APP="/home/$APP_USER/web/$DOMAIN/private/nodeapp"
PM2_APP="$DOMAIN"
LOCAL_APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="https://$DOMAIN/robots.txt"

BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

DO_SCHEMA=0; RESTART_ONLY=0; LOGS_ONLY=0; DO_BROKERS=0
for arg in "$@"; do
  case "$arg" in
    --schema)       DO_SCHEMA=1 ;;
    --restart-only) RESTART_ONLY=1 ;;
    --logs)         LOGS_ONLY=1 ;;
    --brokers)      DO_BROKERS=1 ;;
    --help|-h)      sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown option: $arg" ;;
  esac
done

# One multiplexed SSH connection for the whole run, so the password is typed
# once. The socket is removed on exit however the script ends.
#
# VC_SSH_CONTROL points the script at a master somebody else already opened —
# which is how this runs unattended, with the password supplied out of band:
#
#     SSHPASS='…' sshpass -e ssh -o ControlMaster=auto \
#       -o ControlPath=~/.ssh/cm-vesopa-cloud.sock -o ControlPersist=30m \
#       root@34.63.118.67 true
#     VC_SSH_CONTROL=~/.ssh/cm-vesopa-cloud.sock ./deploy-cloud.sh
#
# A borrowed master is NOT torn down at the end. Closing a connection this
# script did not open would kill whatever else is using it, and the next
# command would sit at a password prompt nothing can answer.
CTL="${VC_SSH_CONTROL:-/tmp/vc-deploy-$$.sock}"
BORROWED=0; [ -n "${VC_SSH_CONTROL:-}" ] && BORROWED=1
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=300)
cleanup() {
  [ "$BORROWED" = 1 ] && return 0
  ssh "${SSH_OPTS[@]}" -O exit "$SERVER" 2>/dev/null || true
  rm -f "$CTL"
}
trap cleanup EXIT
remote() { ssh "${SSH_OPTS[@]}" "$SERVER" "$@"; }

# Run something as the app's own user, with that user's pm2 daemon.
as_app() { remote "su - $APP_USER -c '$1'"; }

step "Connecting to $SERVER"
remote "true" || die "Could not connect."
ok "Connected"

if [ "$LOGS_ONLY" = 1 ]; then
  # The names pm2 actually writes, not the ones in ecosystem.config.js.
  remote "tail -n 120 -f $REMOTE_APP/logs/out-0.log $REMOTE_APP/logs/error-0.log"
  exit 0
fi

if [ "$RESTART_ONLY" = 0 ]; then
  step "Syncing the app"
  # `--delete` inside the synced directories only. `.env`, `logs/` and
  # `node_modules/` are excluded: the first is the server's own configuration,
  # the second is its history, and the third is built there against its Node.
  rsync -az --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'logs' --exclude '.env' \
    --exclude '.DS_Store' --exclude 'TasksImages' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$LOCAL_APP/src" "$LOCAL_APP/views" "$LOCAL_APP/public" \
    "$LOCAL_APP/scripts" "$LOCAL_APP/terminal" "$LOCAL_APP/files" "$LOCAL_APP/apps" \
    "$LOCAL_APP/package.json" "$LOCAL_APP/package-lock.json" \
    "$LOCAL_APP/schema.sql" "$LOCAL_APP/seed.sql" \
    "$SERVER:$REMOTE_APP/"
  ok "Files synced"

  step "Restoring ownership"
  # rsync as root leaves root-owned files in a directory the app user has to
  # read, and the app then fails on a file it can see but cannot open.
  remote "chown -R $APP_USER:$APP_USER $REMOTE_APP/src $REMOTE_APP/views $REMOTE_APP/public $REMOTE_APP/files $REMOTE_APP/apps $REMOTE_APP/scripts $REMOTE_APP/terminal $REMOTE_APP/package.json $REMOTE_APP/package-lock.json $REMOTE_APP/schema.sql $REMOTE_APP/seed.sql"
  ok "Ownership restored"

  step "Installing dependencies"
  as_app "cd $REMOTE_APP && npm ci --omit=dev --no-audit --no-fund" || warn "npm ci reported a problem — check the output above"
  ok "Dependencies up to date"
fi

if [ "$DO_BROKERS" = 1 ]; then
  step "Installing the root brokers"
  # ---------------------------------------------------------------------------
  # The three privileged halves.
  #
  # They live in /opt rather than being run out of the app directory, because
  # the app directory is owned by an ordinary account and a root daemon must not
  # execute a file that a non-root user can rewrite. rsync puts the source next
  # to the app; this copies it into place as root and restarts the units.
  #
  # Opt-in rather than part of every deploy: restarting these drops every open
  # terminal and file-manager connection on the box, which is not something a
  # routine "push the CSS fix" deploy should do.
  # ---------------------------------------------------------------------------
  for b in terminal files apps; do
    remote "install -d -m 0755 /opt/vesopa-$b \
      && install -m 0755 $REMOTE_APP/$b/broker.py /opt/vesopa-$b/broker.py \
      && install -m 0644 $REMOTE_APP/$b/vesopa-$b.service /etc/systemd/system/vesopa-$b.service \
      && python3 -m py_compile /opt/vesopa-$b/broker.py" \
      || die "Could not install the $b broker."
  done
  # ENABLE THEN RESTART, and both are needed. `enable --now` starts a unit that
  # is stopped and does NOTHING to one that is already running — so on every
  # deploy after the first it copied the new broker.py into place and left the
  # old code serving, with a cheerful "active" in the check below. The socket's
  # timestamp was the only clue.
  remote "systemctl daemon-reload \
    && systemctl enable vesopa-terminal vesopa-files vesopa-apps >/dev/null \
    && systemctl restart vesopa-terminal vesopa-files vesopa-apps"
  # Prove it, rather than assuming: a unit that enabled and then died leaves the
  # panel silently in mock mode, which looks like everything working.
  step "Checking the brokers"
  remote "for b in terminal files apps; do
            printf '%-10s %-10s %s\n' \"\$b\" \"\$(systemctl is-active vesopa-\$b)\" \"\$(ls -l /run/vesopa-\$b/broker.sock 2>/dev/null || echo 'no socket')\";
          done"
  ok "Brokers installed"
fi

if [ "$DO_SCHEMA" = 1 ]; then
  step "Applying schema.sql"
  # EVERY connection detail comes out of the server's own .env, the database
  # NAME included. It used to be a constant up top, and the constant was the
  # name on the old box — so this step died with "access denied ... to database
  # vesopa_hostingdb" on a server whose database is vesopasoftware_hostingdb,
  # which reads like a permissions problem and is not one. The server is the
  # only thing that knows what it is called; ask it.
  remote "cd $REMOTE_APP \
    && DBU=\$(grep -E '^DB_USER=' .env | cut -d= -f2-) \
    && DBP=\$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2-) \
    && DBN=\$(grep -E '^DB_NAME=' .env | cut -d= -f2-) \
    && mysql -u\"\$DBU\" -p\"\$DBP\" \"\$DBN\" < schema.sql"
  ok "Schema applied"
fi

step "Restarting $PM2_APP"
# As the app user, with that user's own pm2 home. Never as root — see the note
# at the top of this file.
as_app "PM2_HOME=/home/$APP_USER/.pm2 pm2 restart $PM2_APP --update-env" \
  || die "pm2 restart failed. Check: ssh $SERVER \"su - $APP_USER -c 'pm2 list'\""
ok "Restarted"

step "Checking the site"
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTH_URL" || echo 000)
if [ "$CODE" = "200" ]; then
  ok "$DOMAIN is answering (HTTP $CODE)"
else
  warn "$DOMAIN answered HTTP $CODE — tail the logs with: $0 --logs"
fi

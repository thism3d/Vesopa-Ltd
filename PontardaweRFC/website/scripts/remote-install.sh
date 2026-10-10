#!/usr/bin/env bash
#
# pontardawerfc.com and member.pontardawerfc.com on the Cloud box. Runs ON
# the box as root, from the folder tool/deploy_pontardawe_site.py uploaded.
#
#   bash remote-install.sh            set up what is missing, then ship the site
#   bash remote-install.sh --check    say what exists and what would be done
#
# IDEMPOTENT: every step looks before it acts.
#
#   pontardawerfc.com         this website (Node, pm2 "pontardawerfc.com",
#                             run as vesopasoftware on 127.0.0.1:$SITE_PORT)
#   member.pontardawerfc.com  the club's members' app, served by the back
#                             office (port 20005) like loyalty.vesopa.com;
#                             LOYALTY_VENUE_HOSTS in the back office .env maps
#                             the name to the venue pontardawe-rfc
#
# The domain was bought on Vesopa Cloud, so its web domain and DNS zone may
# belong to another panel user. Both names are kept under whichever user owns
# pontardawerfc.com (Hestia will not put a subdomain under a different user);
# only the nginx include points them at the Node ports.
#
# WHAT IT NEVER DOES
#   * print a secret, or overwrite an existing .env (it only adds missing keys)
#   * restart anything but pontardawerfc.com by name (the back office restart
#     is done afterwards by tool/deploy_memberships.py --backoffice)
#   * run pm2 as root

set -euo pipefail

DOMAIN=pontardawerfc.com
MEMBER=member.pontardawerfc.com
SLUG=pontardawe-rfc
APPUSER=vesopasoftware
BACKOFFICE=/home/$APPUSER/web/backoffice.vesopaepos.com/private/nodeapp
BACKOFFICE_PORT=20005
AI_FROM=/home/$APPUSER/web/vesopasoftware.com/private/nodeapp/.env
AUTH=/home/$APPUSER/web/auth.vesopa.com/private/nodeapp
# Its own name, never PORT: .env files sourced on this box carry other apps' PORT.
readonly SITE_PORT=${PRFC_PORT:-5090}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
export PATH=$PATH:/usr/local/hestia/bin

say()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pm2u() { su - "$APPUSER" -c "PM2_HOME=/home/$APPUSER/.pm2 pm2 $*"; }
act()  { if [ $CHECK = 1 ]; then warn "would: $*"; else "$@"; fi; }
setkey() { # setkey FILE KEY VALUE: add or replace one line, value never echoed
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" >> "$1"; fi
}

[ -f "$HERE/site/src/server.js" ] || die "no site/ in the bundle"
[ -d "$BACKOFFICE" ] || die "the back office is not at $BACKOFFICE"

# ------------------------------------------------------------------ who owns the name
OWNER=$(v-search-domain-owner "$DOMAIN" web 2>/dev/null || true)
[ -n "$OWNER" ] || OWNER=$(v-search-domain-owner "$DOMAIN" 2>/dev/null || true)
if [ -n "$OWNER" ]; then ok "$DOMAIN belongs to panel user $OWNER"; else OWNER=$APPUSER; warn "$DOMAIN is not on the panel yet: it will be added under $OWNER"; fi
if [ "$OWNER" = "$APPUSER" ]; then APP=/home/$APPUSER/web/$DOMAIN/private/nodeapp; else APP=/home/$APPUSER/apps/$DOMAIN; fi
ok "the site's code goes in $APP"

# ------------------------------------------------------------------ port
if ss -ltn | grep -q "127.0.0.1:$SITE_PORT \|\*:$SITE_PORT \|:::$SITE_PORT "; then
  pm2u "describe $DOMAIN" >/dev/null 2>&1 || die "port $SITE_PORT is taken by something else: run with PRFC_PORT=<free port>"
fi

# ------------------------------------------------------------------ DNS: member A record
PUBLIC_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "")
IP=$(v-list-sys-ips plain 2>/dev/null | awk '{print $1; exit}')
ZONE_USER=""
for u in $(v-list-users plain 2>/dev/null | cut -f1); do
  if v-list-dns-domains "$u" plain 2>/dev/null | cut -f1 | grep -qx "$DOMAIN"; then ZONE_USER=$u; break; fi
done
if [ -n "$ZONE_USER" ]; then
  if v-list-dns-records "$ZONE_USER" "$DOMAIN" plain | awk -F'\t' '$2=="member"' | grep -q .; then
    ok "DNS: member.$DOMAIN exists (zone of $ZONE_USER)"
  else
    say "DNS: adding member A ${PUBLIC_IP:-$IP} to $DOMAIN (zone of $ZONE_USER)"
    act v-add-dns-record "$ZONE_USER" "$DOMAIN" member A "${PUBLIC_IP:-$IP}"
  fi
else
  warn "DNS: $DOMAIN is not a zone on this box. Add 'member A ${PUBLIC_IP:-<this box>}' where its DNS is hosted, then run again."
fi

# ------------------------------------------------------------------ web domains, proxy, include
CONF=/home/$OWNER/conf/web
MODEL=/home/$APPUSER/conf/web/auth.vesopa.com/nodeapp.conf
web_domain() { # web_domain NAME PORT
  local name=$1 port=$2
  if v-list-web-domains "$OWNER" plain | cut -f1 | grep -qx "$name"; then
    ok "web domain $name exists"
  else
    say "adding web domain $name under $OWNER"
    act v-add-web-domain "$OWNER" "$name" "$IP"
  fi
  [ $CHECK = 1 ] && ! v-list-web-domains "$OWNER" plain | cut -f1 | grep -qx "$name" && return 0
  local cur
  cur=$(v-list-web-domain "$OWNER" "$name" shell 2>/dev/null | awk '/^PROXY:/{print $2}')
  if [ "$cur" != "NodeJS" ]; then
    say "$name proxy template ${cur:-none} -> NodeJS"
    act v-change-web-domain-proxy-tpl "$OWNER" "$name" NodeJS
  fi
  if [ -f "$MODEL" ]; then
    if ! grep -qs "127.0.0.1:$port" "$CONF/$name/nodeapp.conf"; then
      say "nginx include $CONF/$name/nodeapp.conf -> 127.0.0.1:$port"
      if [ $CHECK = 0 ]; then
        mkdir -p "$CONF/$name"
        sed -E "s/127\.0\.0\.1:[0-9]+/127.0.0.1:$port/g; s/localhost:[0-9]+/127.0.0.1:$port/g; s/auth\.vesopa\.com/$name/g" "$MODEL" > "$CONF/$name/nodeapp.conf"
      fi
    else
      ok "$name -> 127.0.0.1:$port"
    fi
  else
    warn "no $MODEL to copy: point $name at 127.0.0.1:$port by hand"
  fi
  if v-list-web-domain "$OWNER" "$name" shell 2>/dev/null | awk '/^SSL:/{print $2}' | grep -qi yes; then
    ok "$name certificate present"
  else
    say "$name: Let's Encrypt certificate (needs DNS to point here)"
    act v-add-letsencrypt-domain "$OWNER" "$name" "" || warn "$name certificate not issued yet (DNS may not have spread): run again later"
    act v-add-web-domain-ssl-force "$OWNER" "$name" || true
  fi
}
web_domain "$DOMAIN" "$SITE_PORT"
web_domain "$MEMBER" "$BACKOFFICE_PORT"

# ------------------------------------------------------------------ back office: the member host
if grep -qE "^LOYALTY_VENUE_HOSTS=.*$MEMBER=$SLUG" "$BACKOFFICE/.env"; then
  ok "back office .env maps $MEMBER to $SLUG"
else
  say "back office .env: LOYALTY_VENUE_HOSTS gains $MEMBER=$SLUG"
  if [ $CHECK = 0 ]; then
    CUR=$(grep -E '^LOYALTY_VENUE_HOSTS=' "$BACKOFFICE/.env" | head -1 | cut -d= -f2- || true)
    setkey "$BACKOFFICE/.env" LOYALTY_VENUE_HOSTS "${CUR:+$CUR,}$MEMBER=$SLUG"
  fi
fi

# ------------------------------------------------------------------ Vesopa Auth: sign-in comes back to the member host
CLIENT=$(grep -E '^VESOPA_LOYALTY_CLIENT_ID=' "$BACKOFFICE/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)
if [ -z "$CLIENT" ]; then
  warn "no VESOPA_LOYALTY_CLIENT_ID in the back office .env: sign-in on $MEMBER needs its callback added by hand"
elif [ -f "$AUTH/.env" ]; then
  ADB=$(grep -E '^DB_NAME=' "$AUTH/.env" | cut -d= -f2- | tr -d '"'"'"'')
  SQL="INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
       SELECT id, 'https://$MEMBER/app/vesopa/callback', 'login' FROM applications WHERE client_id = '$CLIENT';
       INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
       SELECT id, 'https://$MEMBER/', 'logout' FROM applications WHERE client_id = '$CLIENT';"
  if [ $CHECK = 0 ]; then
    mariadb "$ADB" -e "$SQL"
  else
    warn "would: add https://$MEMBER/app/vesopa/callback to the loyalty client's sign-in addresses"
  fi
  N=$(mariadb "$ADB" -N -e "SELECT COUNT(*) FROM application_redirect_uris r JOIN applications a ON a.id = r.application_id WHERE a.client_id = '$CLIENT' AND r.uri LIKE 'https://$MEMBER/%'" 2>/dev/null || echo 0)
  ok "Auth: $N address(es) for $MEMBER on the loyalty client"
else
  warn "no $AUTH/.env: add the callback by hand"
fi

[ $CHECK = 1 ] && { ok "check done: nothing changed"; exit 0; }

# ------------------------------------------------------------------ the site's code
say "shipping the site to $APP"
mkdir -p "$APP" "$APP/logs"
LOCK_OLD=$(sha256sum "$APP/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)
rm -rf "$APP/src.new" "$APP/public.new" "$APP/content.new"
cp -a "$HERE/site/src" "$APP/src.new"; cp -a "$HERE/site/public" "$APP/public.new"; cp -a "$HERE/site/content" "$APP/content.new"
for d in src public content; do rm -rf "$APP/$d"; mv "$APP/$d.new" "$APP/$d"; done
cp -a "$HERE/site/package.json" "$HERE/site/package-lock.json" "$APP/"

[ -f "$APP/.env" ] || { say "writing .env (first deploy)"; : > "$APP/.env"; }
grep -q '^NODE_ENV=' "$APP/.env" || echo "NODE_ENV=production" >> "$APP/.env"
setkey "$APP/.env" PORT "$SITE_PORT"
grep -q '^SITE_URL=' "$APP/.env" || echo "SITE_URL=https://$DOMAIN" >> "$APP/.env"
grep -q '^MEMBERS_URL=' "$APP/.env" || echo "MEMBERS_URL=https://$MEMBER" >> "$APP/.env"
grep -q '^MENU_API=' "$APP/.env" || echo "MENU_API=https://menu.vesopa.com" >> "$APP/.env"
grep -q '^MENU_SLUG=' "$APP/.env" || echo "MENU_SLUG=$SLUG" >> "$APP/.env"
grep -q '^AI_DAILY_CAP_USD=' "$APP/.env" || echo "AI_DAILY_CAP_USD=0.5" >> "$APP/.env"
grep -q '^LOG_DIR=' "$APP/.env" || echo "LOG_DIR=$APP/logs" >> "$APP/.env"
# The helper's AI keys: the website keys vesopasoftware.com already uses
# (tool/deploy_deepseek_ai.py). Copied once, never printed. Without them the
# helper answers from the club's FAQ.
for k in DEEPSEEK_API_KEY GEMINI_API_KEY; do
  if ! grep -q "^$k=." "$APP/.env" && [ -f "$AI_FROM" ] && grep -q "^$k=." "$AI_FROM"; then
    grep "^$k=" "$AI_FROM" | head -1 >> "$APP/.env" && ok "$k copied from vesopasoftware.com"
  fi
done
grep -q '^DEEPSEEK_API_KEY=.' "$APP/.env" || warn "no DEEPSEEK_API_KEY: the helper will answer from the FAQ only"
chown -R "$APPUSER:$APPUSER" "$APP"
chmod 600 "$APP/.env"

cd "$APP"
LOCK_NEW=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$LOCK_OLD" != "$LOCK_NEW" ]; then
  say "npm ci"
  su - "$APPUSER" -c "cd $APP && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2"
fi

if pm2u "describe $DOMAIN" >/dev/null 2>&1; then
  su - "$APPUSER" -c "cd $APP && PORT=$SITE_PORT PM2_HOME=/home/$APPUSER/.pm2 pm2 restart $DOMAIN --update-env" >/dev/null && ok "restarted $DOMAIN"
else
  su - "$APPUSER" -c "cd $APP && PORT=$SITE_PORT PM2_HOME=/home/$APPUSER/.pm2 pm2 start $APP/src/server.js --name $DOMAIN --cwd $APP --max-memory-restart 200M" >/dev/null && ok "started $DOMAIN"
fi
pm2u save >/dev/null

v-restart-proxy >/dev/null 2>&1 || systemctl reload nginx || true
v-restart-web >/dev/null 2>&1 || true
sleep 4
curl -fsS "http://127.0.0.1:$SITE_PORT/health" && echo || warn "the site is not answering on $SITE_PORT: pm2 logs $DOMAIN"
for u in "https://$DOMAIN/" "https://$DOMAIN/menu" "https://$DOMAIN/sitemap.xml" "https://www.$DOMAIN/" "https://$MEMBER/"; do
  curl -sS -o /dev/null -w "    %{http_code} %{redirect_url}  $u\n" "$u" || warn "$u not answering yet (DNS or certificate)"
done
ok "site done (the back office goes next)"

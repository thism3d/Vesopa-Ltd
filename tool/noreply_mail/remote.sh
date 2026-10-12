#!/bin/bash
# Runs ON the Cloud box as root. See tool/setup_noreply_mail.py.
# The password arrives in $NOREPLY_PW and is never echoed.
set -u
H=/usr/local/hestia/bin
APP=/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp
ENVF="$APP/.env"
[ -n "${NOREPLY_PW:-}" ] || { echo "NOREPLY_PW not set"; exit 1; }

owner=""
for d in /usr/local/hestia/data/users/*; do
  u=$(basename "$d")
  if $H/v-list-mail-domain "$u" vesopa.com >/dev/null 2>&1; then owner=$u; break; fi
done
[ -n "$owner" ] || { echo "no Hestia user has the vesopa.com mail domain"; exit 1; }
echo "vesopa.com mail domain belongs to: $owner"

if $H/v-list-mail-account "$owner" vesopa.com no-reply >/dev/null 2>&1; then
  $H/v-change-mail-account-password "$owner" vesopa.com no-reply "$NOREPLY_PW" && echo "no-reply@vesopa.com: password set"
else
  $H/v-add-mail-account "$owner" vesopa.com no-reply "$NOREPLY_PW" && echo "no-reply@vesopa.com: mailbox created"
fi || { echo "Hestia refused the mailbox change"; exit 1; }

# Prove the login before touching the auth site.
cd "$APP"
check() {
  node -e '
    const nm=require("nodemailer");
    const t=nm.createTransport({host:"mail.vesopa.com",port:587,secure:false,requireTLS:true,
      auth:{user:"no-reply@vesopa.com",pass:process.env.NOREPLY_PW}});
    t.verify().then(()=>{console.log("SMTP login on mail.vesopa.com:587 OK");process.exit(0)})
     .catch(e=>{console.log("SMTP login FAILED: "+e.message);process.exit(1)});'
}
sleep 2
check || exit 1

cp -p "$ENVF" "$ENVF.bak_noreply_$(date +%Y%m%d_%H%M%S)"
setkey() {  # setkey NAME VALUE, value read from the environment, never the command line
  KEY="$1" VAL="$2" python3 - "$ENVF" <<'PY'
import os, sys, re
p = sys.argv[1]; k = os.environ["KEY"]; v = os.environ["VAL"]
lines = open(p).read().splitlines()
out, done = [], False
for l in lines:
    if re.match(rf"^{re.escape(k)}=", l):
        if not done: out.append(f"{k}={v}"); done = True
    else: out.append(l)
if not done: out.append(f"{k}={v}")
open(p, "w").write("\n".join(out) + "\n")
PY
}
setkey SMTP_HOST mail.vesopa.com
setkey SMTP_PORT 587
setkey SMTP_SECURE false
setkey SMTP_USER no-reply@vesopa.com
setkey SMTP_PASSWORD "$NOREPLY_PW"
setkey MAIL_FROM "Vesopa <no-reply@vesopa.com>"
chown vesopasoftware:vesopasoftware "$ENVF"; chmod 600 "$ENVF"
echo "auth .env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, MAIL_FROM set"

su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 restart auth.vesopa.com --update-env' >/dev/null
sleep 3
echo "health $(curl -sS -o /dev/null -w '%{http_code}' https://auth.vesopa.com/health)"
# The app's own settings, as it now reads them.
node -e '
  const c=require("./src/config").mail;
  require("nodemailer").createTransport({host:c.host,port:c.port,secure:c.secure,auth:c.user?{user:c.user,pass:c.password}:undefined})
   .verify().then(()=>console.log("auth app mail settings verify OK ("+c.host+":"+c.port+")")).catch(e=>console.log("auth app verify FAILED: "+e.message));'

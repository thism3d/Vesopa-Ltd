#!/usr/bin/env bash
# Install the admin "Send SMS" panel (BulkSMSBD) on cloud.vesopa.com.
# The four files are already in /root/sms_deploy (uploaded and hash-checked).
# Usage: bash install.sh <BULKSMSBD_API_KEY> <SENDER_ID>
set -e
KEY="$1"; SID="${2:-8809617626388}"
[ -n "$KEY" ] || { echo "usage: install.sh <api_key> [sender_id]"; exit 1; }
N=/home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp; S=/root/sms_deploy
BK=/root/vesopa-backups/cloud_sms_$(date +%Y%m%d_%H%M%S); mkdir -p $BK; chmod 700 $BK
cp -a $N/src/routes/admin.js $N/views/partials/admin-shell.ejs $N/.env $BK/
cp $S/admin.js $N/src/routes/admin.js; cp $S/admin-shell.ejs $N/views/partials/admin-shell.ejs
cp $S/bulksmsbd.js $N/src/integrations/bulksmsbd.js; cp $S/sms.ejs $N/views/admin/sms.ejs
sed -i '/^BULKSMSBD_/d' $N/.env; printf 'BULKSMSBD_API_KEY=%s\nBULKSMSBD_SENDER_ID=%s\n' "$KEY" "$SID" >> $N/.env
chown vesopasoftware:vesopasoftware $N/src/routes/admin.js $N/views/partials/admin-shell.ejs $N/src/integrations/bulksmsbd.js $N/views/admin/sms.ejs $N/.env
su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; sleep 6
c(){ curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://cloud.vesopa.com$1"; }
a=$(c /); b=$(c /admin/sms); echo "/ $a  /admin/sms $b"
if [ "$a" != 200 ] || [ "$b" != 302 ]; then
  echo "ROLLBACK"
  cp -a $BK/admin.js $N/src/routes/; cp -a $BK/admin-shell.ejs $N/views/partials/; cp -a $BK/.env $N/
  rm -f $N/src/integrations/bulksmsbd.js $N/views/admin/sms.ejs
  su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; exit 1
fi
echo "OK - Send SMS is live at https://cloud.vesopa.com/admin/sms (backup $BK)"

#!/usr/bin/env bash
set -euo pipefail
N=/home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK=/root/vesopa-backups/cloud_panel_lock_$(date +%Y%m%d_%H%M%S)
declare -A EXPECT=(
  [src/db.js]=8228ce847fcafde4967ccf1140bc7678d348b4aeb756d83b7794f3467f7f069b
  [src/provisioning.js]=c5f49aac6713a800416188d430e477c38f2b7505ab4a5db50c5b52cf24c27c01
  [src/config.js]=59bab9599a516d26bf10d94e6a077b4d03a1fd5ee73c7e35b7982b4e16f147e3
  [src/server.js]=9e2238fe5ba8a4f9a672815decb6d6d04aa92e8c4298f9799635bd1073021fa4
  [views/partials/panel-shell.ejs]=410bae63e0cfbb62d1d85019c8ca826def7eb9d76aee0c0bdd4012482ea37fee
  [views/partials/panel-shell-end.ejs]=e52fa224a866d94c27681bb9398132fa9402ee7a344c2167985bd76db9182f20
  [views/partials/header.ejs]=d46a0080d78eb7c88f384cf1809e8e6b650cb290eb8bbab702a5cc324f312966
  [src/i18n/bn/panel.json]=069bcc0b3b7f33ca900f72d16ef4909154fab3af4706e6360a5564d1e742f237
)
for f in "${!EXPECT[@]}"; do [ "$(sha256sum $N/$f | cut -d' ' -f1)" = "${EXPECT[$f]}" ] || { echo "✗ $f differs from the reviewed version — stopping, nothing changed"; exit 1; }; done
echo "✓ live files are the reviewed ones"
mkdir -p $BK && chmod 700 $BK; for f in "${!EXPECT[@]}"; do mkdir -p $BK/$(dirname $f); cp -a $N/$f $BK/$f; done; cp -a $N/.env $BK/.env; echo "✓ backup $BK"
tar -xzf "$HERE/bundle.tgz" -C $N; for f in "${!EXPECT[@]}"; do chown vesopasoftware:vesopasoftware $N/$f; done
sed -i '/^AI_FEATURES=/d' $N/.env; echo 'AI_FEATURES=off' >> $N/.env; chown vesopasoftware:vesopasoftware $N/.env
su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; sleep 5
fail=0; code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://cloud.vesopa.com$1"; }
for u in / /hosting /domains /cart; do [ "$(code $u)" = 200 ] && echo "✓ $u 200" || { echo "✗ $u $(code $u)"; fail=1; }; done
[ "$(code /build)" = 404 ] && echo "✓ /build closed (404)" || { echo "✗ /build $(code /build)"; fail=1; }
[ "$(code /ai/session)" = 404 ] && echo "✓ /ai closed (404)" || { echo "✗ /ai $(code /ai/session)"; fail=1; }
curl -s --max-time 15 https://cloud.vesopa.com/ | grep -q 'assistant.js' && { echo "✗ assistant still on the page"; fail=1; } || echo "✓ no assistant on the page"
curl -s --max-time 15 https://cloud.vesopa.com/ | grep -q 'href="/build"' && { echo "✗ Studio still linked"; fail=1; } || echo "✓ Studio not linked"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "https://cloud.vesopa.com/lang/bn?to=%2Fpanel"); [ "$loc" = "https://cloud.vesopa.com/panel" ] && echo "✓ language switch returns to /panel" || { echo "✗ /lang went to $loc"; fail=1; }
echo "== the lock, against the real database"
su - vesopasoftware -c "cd $N && node -e \"require('dotenv').config(); const db=require('./src/db'); (async()=>{ const hold=db.withLock('vh:selftest', ()=>new Promise(r=>setTimeout(()=>r('first'),1500))); await new Promise(r=>setTimeout(r,200)); const second=await db.withLock('vh:selftest', async()=>'second'); const first=await hold; const third=await db.withLock('vh:selftest', async()=>'third'); console.log('first:',first.locked,first.value,'| second while held:',second.locked,'| third after release:',third.locked,third.value); process.exit(0)})()\"" 2>&1 | grep -v injected | tail -1
if [ $fail -ne 0 ]; then echo "Restoring"; for f in "${!EXPECT[@]}"; do cp -a $BK/$f $N/$f; done; cp -a $BK/.env $N/.env; su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; exit 1; fi
echo "✓ deployed. Backup: $BK"

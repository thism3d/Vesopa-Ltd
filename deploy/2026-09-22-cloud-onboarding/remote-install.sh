#!/usr/bin/env bash
set -euo pipefail
N=/home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK=/root/vesopa-backups/cloud_onboarding_$(date +%Y%m%d_%H%M%S)
declare -A EXPECT=(
  [src/domain-linking.js]=8d44aceb26954b4ad9cdf1fb1a455086606fdaa6841ecbad970e9efce07daa7f
  [src/provisioning.js]=e7ccfe3e7c5d2e22ae05f7ebfe6200131faab843dfd181f7d839e59478213c7e
  [src/routes/setup.js]=4a1d285f23eaf8862454ee06e9695769dbc354cbfcb8e67b8bcab246aae411fa
  [views/panel/setup.ejs]=503616007cce842de490e324335e8c88311d80b1ce5795e0114f39d88a8031f2
  [public/assets/js/setup.js]=adff0a4cbc75cb3e22ebb530902da1b475dd7279be20bcabbe7e6c1c8bcd374d
  [src/i18n/bn/panel.json]=1fa5f2c6864039126fc193208290d115e71be3e85c081b51cc2a3f7a88fb0030
)
for f in "${!EXPECT[@]}"; do [ "$(sha256sum $N/$f | cut -d' ' -f1)" = "${EXPECT[$f]}" ] || { echo "✗ $f differs from the reviewed version — stopping, nothing changed"; exit 1; }; done
[ ! -e $N/src/domain-reality.js ] || { echo "✗ domain-reality.js already exists — stopping"; exit 1; }
echo "✓ live files are the reviewed ones"
mkdir -p $BK && chmod 700 $BK; for f in "${!EXPECT[@]}"; do mkdir -p $BK/$(dirname $f); cp -a $N/$f $BK/$f; done; echo "✓ backup $BK"
tar -xzf "$HERE/bundle.tgz" -C $N
for f in "${!EXPECT[@]}" src/domain-reality.js src/data/iana-tlds.txt test/onboarding.test.js; do chown vesopasoftware:vesopasoftware $N/$f; done; chown vesopasoftware:vesopasoftware $N/src/data
su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; sleep 5
fail=0; code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://cloud.vesopa.com$1"; }
for u in / /hosting /domains /cart; do [ "$(code $u)" = 200 ] && echo "✓ $u 200" || { echo "✗ $u $(code $u)"; fail=1; }; done
[ "$(code /panel/setup/1)" = 302 ] && echo "✓ setup page answers (302 to sign-in)" || { echo "✗ setup $(code /panel/setup/1)"; fail=1; }
st=$(su - vesopasoftware -c "pm2 jlist" | python3 -c 'import sys,json; print([x for x in json.load(sys.stdin) if x["name"]=="cloud.vesopa.com"][0]["pm2_env"]["status"])'); [ "$st" = online ] && echo "✓ pm2 online" || { echo "✗ pm2 $st"; fail=1; }
echo "== the domain check, with real DNS from this server"
su - vesopasoftware -c "cd $N && node -e \"const r=require('./src/domain-reality'); (async()=>{ for (const d of ['wintk999.com','vesopa.com.bd','mysite.comm','shop.xyz123','surely-not-registered-q7x2k9.com']) console.log(d.padEnd(34), (await r.checkRealDomain(d)) || 'OK'); process.exit(0) })()\"" 2>&1
if [ $fail -ne 0 ]; then echo "Restoring"; for f in "${!EXPECT[@]}"; do cp -a $BK/$f $N/$f; done; rm -f $N/src/domain-reality.js; su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; exit 1; fi
echo "✓ deployed. Backup: $BK"

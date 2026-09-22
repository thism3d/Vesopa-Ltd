#!/usr/bin/env bash
# Runs ON the live box as root. Installs the insufficient-balance fix into
# cloud.vesopa.com; refuses if the live files changed; restores on a failed check.
set -euo pipefail
N=/home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK=/root/vesopa-backups/cloud_funds_fix_$(date +%Y%m%d_%H%M%S)
declare -A EXPECT=(
  [src/domain-linking.js]=6afa25eb7a4dfce1711ab50305e1d5b72673b8494d854f2d6cbcaac0e7ac0737
  [src/provisioning.js]=3c72602e1888357d5dad6cb96f5cc9270e1dc28201a7626e6f4825b2fcbec60e
  [src/routes/cart.js]=b3f584a38f7bfed25a4bafc36ffff69dd8ebd90cab0776fead65ed3a86eefa51
  [src/routes/setup.js]=4e74607439308ad4d97ec8ba1f7fa8119b092c5a45a0367810fd88d0f4c10349
)
for f in "${!EXPECT[@]}"; do [ "$(sha256sum $N/$f | cut -d' ' -f1)" = "${EXPECT[$f]}" ] || { echo "✗ $f changed on the server since it was reviewed — stopping, nothing changed"; exit 1; }; done
[ ! -e $N/src/registrar-funds.js ] || { echo "✗ src/registrar-funds.js already exists — stopping"; exit 1; }
echo "✓ live files are the reviewed ones"
mkdir -p $BK && chmod 700 $BK; for f in "${!EXPECT[@]}"; do mkdir -p $BK/$(dirname $f); cp -a $N/$f $BK/$f; done; echo "✓ backup $BK"
mkdir -p $N/test; tar -xzf "$HERE/cloud-fix.tgz" -C $N
chown vesopasoftware:vesopasoftware $N/test $N/src/registrar-funds.js $N/test/registrar-funds.test.js; for f in "${!EXPECT[@]}"; do chown vesopasoftware:vesopasoftware $N/$f; done
su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; sleep 5
fail=0
for u in / /cart /domains; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://cloud.vesopa.com$u); [ "$c" = 200 ] && echo "✓ $u $c" || { echo "✗ $u $c"; fail=1; }; done
if [ $fail -ne 0 ]; then echo "Restoring previous version"; for f in "${!EXPECT[@]}"; do cp -a $BK/$f $N/$f; done; rm -f $N/src/registrar-funds.js; su - vesopasoftware -c "pm2 restart cloud.vesopa.com --update-env" >/dev/null; exit 1; fi
echo "== what checkout would say for a .com right now"
su - vesopasoftware -c "cd $N && node -e \"require('dotenv').config(); require('./src/registrar-funds').check([{kind:'domain',domain:'check.com',years:1}]).then(r=>{console.log(JSON.stringify(r));process.exit(0)})\"" 2>&1 | grep -v injected | tail -1
echo "✓ deployed. Backup: $BK"

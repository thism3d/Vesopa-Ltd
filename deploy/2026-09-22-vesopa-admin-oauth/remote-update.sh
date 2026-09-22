#!/usr/bin/env bash
# Update: Connect with Vesopa is the only way into vesopaepos.com/admin.
# Guards that the live files are exactly what the first deploy installed.
set -euo pipefail
WEB=/home/vesopasoftware/web/vesopaepos.com/private/nodeapp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK=/root/vesopa-backups/update_vesopa_only_$(date +%Y%m%d_%H%M%S)
declare -A EXPECT=(
  [views/admin/login.ejs]=87535d31c2c73d5c7d0b029d101d652e5021c126d12c822adc8838172f82d3ce
  [src/admin/index.js]=54c668d287d09d444c9afa265d2c9f0379dc7c5087b485ef13462012fb48ff13
  [src/admin/vesopa-auth.js]=fa4492ef5bb4a05fb150b26058e90c48a491e9f170592137c8b59a1fbc685d74
  [public/admin-library/panel.css]=92ecb73f463130a92bcb9f2c9d0074ed4ea43ab9888105cbf04ddb6fb364127d
  [test/vesopa-auth.test.js]=9038b8f477954370b296c665c0d573e3b513c6023954699ef538b2b2a7a3229d
)
for f in "${!EXPECT[@]}"; do
  [ "$(sha256sum "$WEB/$f" | cut -d' ' -f1)" = "${EXPECT[$f]}" ] || { echo "✗ $f is not the version the first deploy installed — stopping, nothing changed"; exit 1; }
done
echo "✓ live files are the first deploy's"
mkdir -p "$BK" && chmod 700 "$BK"
for f in "${!EXPECT[@]}"; do mkdir -p "$BK/$(dirname "$f")"; cp -a "$WEB/$f" "$BK/$f"; done
cp -a "$WEB/.env" "$BK/.env"
echo "✓ backed up to $BK"
tar -xzf "$HERE/update-vesopa-only.tgz" -C "$WEB"
for f in "${!EXPECT[@]}"; do chown vesopasoftware:vesopasoftware "$WEB/$f"; done
sed -i '/^VESOPA_AUTH_ADMIN_ONLY=/d' "$WEB/.env"
su - vesopasoftware -c "pm2 restart vesopaepos.com --update-env" >/dev/null; sleep 4
fail=0
page=$(curl -s --max-time 15 https://vesopaepos.com/admin)
echo "$page" | grep -q 'Connect with Vesopa' && echo "✓ /admin shows Connect with Vesopa" || { echo "✗ button missing"; fail=1; }
echo "$page" | grep -q 'name="password"' && { echo "✗ a password field is still on the page"; fail=1; } || echo "✓ no password field"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d 'username=x&password=y' --max-time 15 https://vesopaepos.com/admin)" = 410 ] && echo "✓ password POST refused (410)" || { echo "✗ password POST not 410"; fail=1; }
case "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 https://vesopaepos.com/admin/auth/vesopa/start)" in https://auth.vesopa.com/oauth/authorize*) echo "✓ Connect goes to auth.vesopa.com";; *) echo "✗ start does not reach auth"; fail=1;; esac
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://vesopaepos.com/)" = 200 ] && echo "✓ home 200" || { echo "✗ home not 200"; fail=1; }
if [ $fail -ne 0 ]; then
  echo "Restoring the previous version"; for f in "${!EXPECT[@]}"; do cp -a "$BK/$f" "$WEB/$f"; done; cp -a "$BK/.env" "$WEB/.env"
  su - vesopasoftware -c "pm2 restart vesopaepos.com --update-env" >/dev/null; exit 1
fi
echo "✓ Updated. Backup: $BK"

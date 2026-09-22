#!/usr/bin/env bash
# Back office stock work: install, migrate BEFORE restart, verify, roll back on failure.
set -euo pipefail
N=/home/vesopasoftware/web/backoffice.vesopaepos.com/private/nodeapp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK=/root/vesopa-backups/backoffice_stock_$(date +%Y%m%d_%H%M%S)
DB=vesopasoftware_eposdb
declare -A EXPECT=(
  [src/stock.js]=3fb61a6ffdee3a2d1b695464a64689d34d862e677925487b1d366863dbca42a9
  [src/sales.js]=57f950cba907f438560db766735c1ee464d09716df72e89e533feb82087a930b
  [src/backoffice.js]=17d918dba1afaf6b3bd5633e8520c26c411ee1a9e11f87907f6400b9c0901f7a
  [src/permissions.js]=75d88ea6fe80c23dbe99cddf8fe30b5951bd23a91c028e83729be1bb01a11718
  [public/app.js]=0ba9f8e890216828ecba6d0d17ffa70c85453fb4d126b70fdd027566006b8541
  [public/stock.js]=93def9e02ff07d5c51d161806c868e587c4b7e449796f5b8fe826900068081f2
  [public/index.html]=9ce64b985a6fb2f206bafa2142f5cada4b4748b758656940e3338dd51f67e007
  [public/permissions.js]=6b44939784d141179565653cd22253e37f00d28752ed931e775ce3c0c75a76ab
)
for f in "${!EXPECT[@]}"; do [ "$(sha256sum $N/$f | cut -d' ' -f1)" = "${EXPECT[$f]}" ] || { echo "✗ $f differs from the reviewed version — stopping, nothing changed"; exit 1; }; done
# The migration file may already be there from the first attempt (a rollback keeps
# it, and the migration is re-runnable); only the new module must be absent.
[ ! -e $N/src/stock_effects.js ] || { echo "✗ src/stock_effects.js already exists — stopping"; exit 1; }
echo "✓ live files are the reviewed ones"
mkdir -p $BK && chmod 700 $BK
for f in "${!EXPECT[@]}"; do mkdir -p $BK/$(dirname $f); cp -a $N/$f $BK/$f; done
mariadb-dump --single-transaction $DB bo_products bo_stock_docs bo_stock_doc_lines epos_stock_movements | gzip > $BK/eposdb-stock-tables.sql.gz
chmod -R go-rwx $BK; echo "✓ backup $BK"

echo "== migration first, so no sale ever meets the new code without its table"
mariadb $DB < "$HERE/schema_stock_links_recipes.sql" 2>/dev/null || tar -xzOf "$HERE/bundle.tgz" schema/schema_stock_links_recipes.sql | mariadb $DB
mariadb -N -e "SELECT CONCAT('columns: ', (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='bo_products' AND column_name IN ('non_stock','stock_parent_pluid','stock_ratio','target_gp')), '/4 · recipe table: ', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB' AND table_name='bo_recipe_lines'))"

tar -xzf "$HERE/bundle.tgz" -C $N
for f in "${!EXPECT[@]}" src/stock_effects.js schema/schema_stock_links_recipes.sql test/stock-links-recipes.test.js; do chown vesopasoftware:vesopasoftware $N/$f; done
su - vesopasoftware -c "pm2 restart backoffice.vesopaepos.com --update-env" >/dev/null; sleep 5

fail=0; code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://backoffice.vesopaepos.com$1"; }
[ "$(code /)" = 200 ] && echo "✓ back office 200" || { echo "✗ / $(code /)"; fail=1; }
page=$(curl -s --max-time 15 https://backoffice.vesopaepos.com/)
# grep reads the page itself, not from a pipe: with pipefail, `echo | grep -q` fails
# when grep stops early at a match (SIGPIPE) -- which is what rolled back the first try.
grep -q 'data-view="stock_recipes"' <<< "$page" && echo "✓ Recipes in the menu" || { echo "✗ no Recipes menu item"; fail=1; }
grep -qE 'stock\.js\?v=' <<< "$page" && echo "✓ stock.js served with a fresh content-hash URL" || echo "! stock.js URL has no version (check asset hashing)"
[ "$(code /api/stock/recipes)" = 401 ] && echo "✓ API refuses the unsigned (401)" || { echo "✗ unsigned /api/stock/recipes $(code /api/stock/recipes)"; fail=1; }
st=$(su - vesopasoftware -c "pm2 jlist" | python3 -c 'import sys,json; print([x for x in json.load(sys.stdin) if x["name"]=="backoffice.vesopaepos.com"][0]["pm2_env"]["status"])'); [ "$st" = online ] && echo "✓ pm2 online" || { echo "✗ pm2 $st"; fail=1; }

echo "== signed-in API checks, as the Vesopa Kitchen (Vesopa's own test venue; read-only)"
cd $N && node -e "
require('dotenv').config(); const {issueToken}=require('./src/auth');
const t=issueToken({id:15,email:'manager@vesopa.co.uk',name:'Deploy check',role:'office',officeId:9},process.env.JWT_SECRET,'5m');
const get=(p)=>fetch('https://backoffice.vesopaepos.com/api'+p,{headers:{Authorization:'Bearer '+t}}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}));
(async()=>{
  const sp=await get('/stock/products'); const one=(sp.j||[])[0]||{};
  console.log('/stock/products', sp.s, '·', (sp.j||[]).length, 'products · new fields:', ['stock_item','non_stock','is_linked','is_recipe','gp'].every(k=>k in one) ? 'present' : 'MISSING');
  console.log('  stock items (counted on a stock take):', (sp.j||[]).filter(p=>p.stock_item).length, '· with a GP figure:', (sp.j||[]).filter(p=>p.gp&&p.gp.has_cost).length);
  const r=await get('/stock/recipes'); console.log('/stock/recipes', r.s, Array.isArray(r.j) ? 'list of '+r.j.length : 'NOT A LIST');
  const pr=await get('/products'); console.log('/products', pr.s, '· case-size column:', (pr.j||[]).length && 'pack_size_id' in pr.j[0] ? 'present' : 'MISSING');
  const d=await get('/stock/docs?kind=wastage'); console.log('/stock/docs', d.s);
  if ([sp.s,r.s,pr.s,d.s].some(s=>s!==200) || !['stock_item','gp'].every(k=>k in one)) process.exit(3);
})().catch(e=>{console.error('check failed:',e.message);process.exit(3)});" 2>&1 | grep -v injected || fail=1
echo "== recent errors in the back office log"
tail -n 200 $N/logs/error*.log 2>/dev/null | grep -iE "bo_recipe|stock_effects|non_stock|TypeError|ReferenceError" | tail -5 || true

if [ $fail -ne 0 ]; then
  echo "Restoring the previous version (migration columns stay; they are unused by the old code)"
  for f in "${!EXPECT[@]}"; do cp -a $BK/$f $N/$f; done; rm -f $N/src/stock_effects.js
  su - vesopasoftware -c "pm2 restart backoffice.vesopaepos.com --update-env" >/dev/null; exit 1
fi
echo "✓ deployed. Backup: $BK"

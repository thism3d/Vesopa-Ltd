#!/usr/bin/env bash
# Upload and install the cloud.vesopa.com back office stock work.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTKEY="SHA256:cFMM5RVMN8Zenveptm87xQkaF/rMTiUAR8lKrNsvzo0"
PW=$(grep -E '^VESOPA_SSH_PASSWORD=' /c/Users/Administrator/develop/Vesopa-Ltd/.env.claude | cut -d= -f2- | tr -d "'\"")
PUTTY="/c/Program Files/PuTTY"
echo "mkdir -p /root/deploy_backoffice_stock && chmod 700 /root/deploy_backoffice_stock" > "$HERE/.mk"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.mk")"
"$PUTTY/pscp.exe" -batch -hostkey "$HOSTKEY" -pw "$PW" -q \
  "$(cygpath -w "$HERE/remote-install.sh")" "$(cygpath -w "$HERE/bundle.tgz")" "$(cygpath -w "$HERE/schema_stock_links_recipes.sql")" root@34.63.118.67:/root/deploy_backoffice_stock/
echo "bash /root/deploy_backoffice_stock/remote-install.sh" > "$HERE/.run"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.run")"

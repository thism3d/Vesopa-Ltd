#!/usr/bin/env bash
# Upload the bundle and run remote-deploy.sh on the live box.
#   ./deploy.sh              deploy (+ venue dry run)
#   ./deploy.sh --rollback   undo the code and .env change
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTKEY="SHA256:cFMM5RVMN8Zenveptm87xQkaF/rMTiUAR8lKrNsvzo0"
# Password read from .env.claude, never typed on this command line.
PW=$(grep -E '^VESOPA_SSH_PASSWORD=' /c/Users/Administrator/develop/Vesopa-Ltd/.env.claude | cut -d= -f2- | tr -d "'\"")
PUTTY="/c/Program Files/PuTTY"
echo "mkdir -p /root/deploy_oauth_admin && chmod 700 /root/deploy_oauth_admin" > "$HERE/.mk"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.mk")"
"$PUTTY/pscp.exe" -batch -hostkey "$HOSTKEY" -pw "$PW" -q \
  "$(cygpath -w "$HERE/remote-deploy.sh")" "$(cygpath -w "$HERE/auth.tgz")" "$(cygpath -w "$HERE/web.tgz")" \
  root@34.63.118.67:/root/deploy_oauth_admin/
echo "bash /root/deploy_oauth_admin/remote-deploy.sh ${1:-}" > "$HERE/.run"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.run")"

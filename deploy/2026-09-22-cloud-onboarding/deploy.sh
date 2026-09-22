#!/usr/bin/env bash
# Upload and install the cloud.vesopa.com onboarding fixes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTKEY="SHA256:cFMM5RVMN8Zenveptm87xQkaF/rMTiUAR8lKrNsvzo0"
PW=$(grep -E '^VESOPA_SSH_PASSWORD=' /c/Users/Administrator/develop/Vesopa-Ltd/.env.claude | cut -d= -f2- | tr -d "'\"")
PUTTY="/c/Program Files/PuTTY"
echo "mkdir -p /root/deploy_cloud_onboarding && chmod 700 /root/deploy_cloud_onboarding" > "$HERE/.mk"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.mk")"
"$PUTTY/pscp.exe" -batch -hostkey "$HOSTKEY" -pw "$PW" -q \
  "$(cygpath -w "$HERE/remote-install.sh")" "$(cygpath -w "$HERE/bundle.tgz")" root@34.63.118.67:/root/deploy_cloud_onboarding/
echo "bash /root/deploy_cloud_onboarding/remote-install.sh" > "$HERE/.run"
"$PUTTY/plink.exe" -ssh -batch -hostkey "$HOSTKEY" -l root -pw "$PW" 34.63.118.67 -m "$(cygpath -w "$HERE/.run")"

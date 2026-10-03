#!/usr/bin/env bash
# Copies the shared cookie notice into every Vesopa website that serves it.
# Run after editing vesopa-cookies.js or vesopa-cookies.css, then commit the copies.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
targets=(
  vesopa_web/public           # vesopaepos.com
  vesopasoftware/site         # vesopasoftware.com
  vesopa_auth/public          # auth.vesopa.com
  vesopa_hosting/public       # cloud.vesopa.com
  vesopa_gift/public          # gift card shops
)
for t in "${targets[@]}"; do
  cp "$here/vesopa-cookies.js" "$here/vesopa-cookies.css" "$repo/$t/"
  echo "copied to $t"
done

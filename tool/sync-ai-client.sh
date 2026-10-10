#!/usr/bin/env bash
# Copies the shared AI client into every Node service that calls a model.
# Run after editing shared/ai-client/vesopa_ai.js, then commit the copies.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
src="$repo/shared/ai-client/vesopa_ai.js"
targets=(
  vesopa_hosting/src/ai/vesopa_ai.js          # cloud.vesopa.com (CommonJS)
  vesopasoftware/server/lib/vesopa_ai.cjs     # vesopasoftware.com (ESM package, so .cjs)
  PontardaweRFC/website/src/vesopa_ai.js      # pontardawerfc.com club helper
)
for t in "${targets[@]}"; do
  cp "$src" "$repo/$t"
  echo "copied to $t"
done

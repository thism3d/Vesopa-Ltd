#!/usr/bin/env bash
# Copy the shared activity logger into every service and app that uses it.
#
#   tool/sync-activity-log.sh          copy
#   tool/sync-activity-log.sh --check  exit 1 if any copy differs (used by the test)
#
# Each Node service and each Flutter app is deployed or built from its own
# folder, so none can import from shared/ at runtime. One canonical copy, synced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_SRC="$ROOT/shared/activity-log/activity_log.js"
DART_SRC="$ROOT/shared/activity-log/activity_log.dart"
NODE_TARGETS=(vesopa_server vesopa_web vesopa_auth vesopa_hosting vesopa_gift vesopa_metric_server)
DART_TARGETS=(vesopa_epos vesopa_epos_kitchen vesopa_epos_display vesopa_express vesopa_loyalty)
status=0
sync_one() {
  local src="$1" dst="$2"
  if [[ "${1:-}" != "" && "${CHECK:-0}" == "1" ]]; then
    if ! cmp -s "$src" "$dst"; then echo "out of date: ${dst#$ROOT/}"; status=1; fi
  else
    cp "$src" "$dst"; echo "synced ${dst#$ROOT/}"
  fi
}
[[ "${1:-}" == "--check" ]] && CHECK=1
for t in "${NODE_TARGETS[@]}"; do sync_one "$NODE_SRC" "$ROOT/$t/src/activity_log.js"; done
for t in "${DART_TARGETS[@]}"; do sync_one "$DART_SRC" "$ROOT/$t/lib/data/activity_log.dart"; done
exit $status

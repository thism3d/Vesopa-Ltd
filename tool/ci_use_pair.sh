#!/usr/bin/env bash
# Export the client id, secret and tenant the secrets job found to work.
#
#   bash tool/ci_use_pair.sh <ID_NAME:SECRET_NAME:TENANT_NAME> <AZURE|MS_STORE>
#
# The first argument holds secret NAMES (the secrets job's sign_pair or
# store_pair output, from tool/ci_find_signing.py); their values must be in this
# step's environment. Sets <PREFIX>_TENANT_ID, _CLIENT_ID and _CLIENT_SECRET for
# the steps after this one. Prints names only.
set -eu
pair=${1:-}
prefix=$2
if [ -z "$pair" ]; then
  echo "::error::No client id and secret signed in for $prefix in the secrets job; its 'Code signing account and profile' step says which were tried."
  exit 1
fi
IFS=: read -r id_name secret_name tenant_name <<< "$pair"
for kv in "TENANT_ID:$tenant_name" "CLIENT_ID:$id_name" "CLIENT_SECRET:$secret_name"; do
  key=${prefix}_${kv%%:*}; src=${kv#*:}
  value=${!src:-}
  [ -n "$value" ] || { echo "::error::$src is empty in this job"; exit 1; }
  echo "::add-mask::$value"
  d="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s<<%s\n%s\n%s\n' "$key" "$d" "$value" "$d" >> "$GITHUB_ENV"
  echo "  $key: from $src"
done

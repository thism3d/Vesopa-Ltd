#!/usr/bin/env bash
# Pick each setting a GitHub Actions job needs from whichever secret holds it.
#
#   bash tool/ci_pick_secrets.sh CANON=CAND1,CAND2 CANON2=... [--check]
#
# The workflow puts every candidate secret in the step's environment under its
# own name. For each CANON the first non-empty candidate wins; failing that,
# a KEY=VALUE line for CANON (or a candidate) inside one of the secrets named in
# ENV_FILE_SECRETS (a whole .env.claude pasted in as one secret). The winner is
# exported to later steps under CANON through $GITHUB_ENV. Only names are
# printed, never values. With --check nothing is exported; it only reports.
# Exits 1 if any CANON was found nowhere.
set -u
check=false
missing=""
for spec in "$@"; do
  [ "$spec" = "--check" ] && { check=true; continue; }
  canon=${spec%%=*}
  cands="$canon,${spec#*=}"
  value=""; from=""
  IFS=, read -ra names <<< "$cands"
  for n in "${names[@]}"; do
    [ -n "$n" ] || continue
    v=${!n:-}
    if [ -n "$v" ]; then value=$v; from=$n; break; fi
  done
  if [ -z "$value" ]; then
    for blob in ${ENV_FILE_SECRETS:-}; do
      text=${!blob:-}
      [ -n "$text" ] || continue
      for n in "${names[@]}"; do
        [ -n "$n" ] || continue
        line=$(printf '%s\n' "$text" | tr -d '\r' | grep -E "^[[:space:]]*(export[[:space:]]+)?$n[[:space:]]*=" | tail -1)
        [ -n "$line" ] || continue
        v=${line#*=}
        v=$(printf '%s' "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
        if [ -n "$v" ]; then value=$v; from="$blob ($n=)"; break 2; fi
      done
    done
  fi
  if [ -z "$value" ]; then
    echo "  $canon: not found (looked for ${cands//,/, }${ENV_FILE_SECRETS:+, and inside $ENV_FILE_SECRETS})"
    missing="$missing $canon"
    continue
  fi
  echo "  $canon: from $from"
  if ! $check && [ -n "${GITHUB_ENV:-}" ]; then
    echo "::add-mask::$value"
    d="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    printf '%s<<%s\n%s\n%s\n' "$canon" "$d" "$value" "$d" >> "$GITHUB_ENV"
    echo "${canon}_FROM=${from%% *}" >> "$GITHUB_ENV"
  fi
done
if [ -n "$missing" ]; then
  echo "::error::Not found in the 'App Store Connect API' environment's secrets:$missing (see the top of .github/workflows/windows-till-release.yml)."
  exit 1
fi

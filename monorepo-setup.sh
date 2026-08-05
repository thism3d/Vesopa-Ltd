#!/usr/bin/env bash
#
# Vesopa-Ltd — one-time setup for the umbrella repository.
#
# THE PROBLEM THIS SOLVES
#
# `vesopa_epos` and `vesopa_server` are already git repositories with their own
# history and their own GitHub remotes. When a repo contains another repo, git
# does NOT store the inner files — it stores a single "gitlink" entry: one line
# recording a commit SHA. Cloning the outer repo gives you an empty folder where
# the project should be, and there is no warning beyond one hint at `git add`.
#
# Proven, not assumed:
#     $ git add -A
#     warning: adding embedded git repository: sub
#     $ git ls-files -s
#     160000 5e0c433... 0    sub        <- a pointer, not the files
#
# Ignoring the inner `.git` does not help. Adding the file by path does not help
# either — git refuses with "Pathspec is in submodule".
#
# THE FIX
#
# Move each inner `.git` OUT of the tree, commit from the parent, move it back.
# The parent then holds the real files, and both inner repos keep their history,
# their branches and their remotes untouched.
#
# It only has to be done ONCE. After the files are tracked as ordinary blobs,
# later edits and brand-new files inside those folders are picked up by a normal
# `git add -A` from the root, even with the inner `.git` back in place.
#
# The inner `.git` folders are parked OUTSIDE the working tree on purpose. Left
# inside as `.git.bak` they would themselves be committed — a repo inside a repo
# as plain files, which is worse than the problem being fixed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARK="$(dirname "$ROOT")/.vesopa-parked-git"
NESTED=(vesopa_epos vesopa_server)

cd "$ROOT"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

# -----------------------------------------------------------------------------
park() {
  mkdir -p "$PARK"
  for d in "${NESTED[@]}"; do
    if [ -d "$ROOT/$d/.git" ]; then
      say "parking $d/.git"
      mv "$ROOT/$d/.git" "$PARK/$d.git"
    fi
  done
}

restore() {
  for d in "${NESTED[@]}"; do
    if [ -d "$PARK/$d.git" ]; then
      say "restoring $d/.git"
      mv "$PARK/$d.git" "$ROOT/$d/.git"
    fi
  done
  rmdir "$PARK" 2>/dev/null || true
}

# Whatever happens — an error, a Ctrl-C, a full disk — the inner repos go back.
# Leaving somebody's git history parked in a hidden folder because a script died
# halfway is not an acceptable failure mode.
trap restore EXIT INT TERM

# -----------------------------------------------------------------------------
# Refuse to run if anything sensitive would be caught. This is the last line of
# defence before a credential becomes permanent: a secret committed once stays
# in the history, in every clone and in GitHub's cache, and rotating it is then
# the only remedy.
# -----------------------------------------------------------------------------
guard_secrets() {
  local found
  found=$(git ls-files --others --cached --exclude-standard 2>/dev/null \
    | grep -iE '(^|/)\.env($|\.)|\.key$|\.keystore$|\.jks$|\.pem$|\.p12$|credentials.*\.json|google-services\.json' \
    | grep -v '\.example$' || true)
  if [ -n "$found" ]; then
    warn "REFUSING TO CONTINUE — these would be committed:"
    printf '     %s\n' $found
    warn "Fix .gitignore first. Nothing has been committed."
    exit 1
  fi
  say "secret check passed — no .env, key or certificate is staged"
}

# -----------------------------------------------------------------------------
case "${1:-commit}" in
  commit)
    [ -d "$ROOT/.git" ] || { say "git init"; git init -q -b main "$ROOT"; }

    park
    say "staging everything (this is the step the parking exists for)"
    git add -A
    guard_secrets

    echo
    say "$(git diff --cached --numstat | wc -l | tr -d ' ') files staged:"
    git diff --cached --numstat | awk -F/ '{print $1}' | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'
    echo

    if git rev-parse HEAD >/dev/null 2>&1; then
      git commit -qm "Update all Vesopa projects" || say "nothing to commit"
    else
      git commit -qm "Vesopa Ltd — web, EPOS, back office and hosting"
    fi
    say "committed. Nothing has been pushed."
    ;;

  status)
    park
    git add -A --dry-run 2>/dev/null | head -20
    ;;

  *)
    echo "usage: $0 [commit|status]" >&2
    exit 2
    ;;
esac

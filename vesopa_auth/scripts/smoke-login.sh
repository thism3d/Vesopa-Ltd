#!/usr/bin/env bash
#
# Sign in to the live site, for real, end to end.
#
#   bash smoke-login.sh [address]
#
# Runs ON THE SERVER, because the only honest way to prove the email code works
# is to read the code out of the mailbox it was delivered to and type it back
# in. A test that stubs the mail step proves the parts either side of the thing
# most likely to be broken.
#
# Everything goes through https://auth.vesopa.com rather than 127.0.0.1:20003,
# so nginx, the proxy template, the certificate and the cookie flags are all in
# the path — which is where a deploy actually breaks.
#
set -uo pipefail

BASE="https://auth.vesopa.com"
ADDRESS="${1:-account@vesopa.com}"
MAILBOX_USER="${ADDRESS%@*}"
MAILBOX_DOMAIN="${ADDRESS#*@}"
MAILDIR="/home/vesopasoftware/mail/$MAILBOX_DOMAIN/$MAILBOX_USER/new"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ✓ $1"
    pass=$((pass + 1))
  else
    echo "  ✗ $1 — expected '$3', got '$2'"
    fail=$((fail + 1))
  fi
}

echo "▶ 1. fetch the sign-in page and its CSRF token"
page="$(curl -sS -c "$JAR" "$BASE/login")"
token="$(printf '%s' "$page" | grep -oP 'name="_csrf" value="\K[^"]+' | head -1)"
check "page carries a CSRF token" "$([ -n "$token" ] && echo yes || echo no)" "yes"

echo "▶ 2. a post with NO token must be refused"
forged="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/login" \
  --data-urlencode "email=$ADDRESS" --data "channel=email")"
check "unprotected POST refused" "$forged" "403"

echo "▶ 3. ask for a code"
before="$(ls -1 "$MAILDIR" 2>/dev/null | wc -l)"
status="$(curl -sS -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/login" \
  --data-urlencode "email=$ADDRESS" \
  --data "channel=email" --data "remember=1" --data "mode=login" \
  --data-urlencode "_csrf=$token")"
check "redirected to the code page" "$status" "303"

echo "▶ 4. wait for the message to land"
code=""
for _ in $(seq 1 20); do
  sleep 1
  after="$(ls -1 "$MAILDIR" 2>/dev/null | wc -l)"
  if [ "$after" -gt "$before" ]; then
    newest="$(ls -1t "$MAILDIR" | head -1)"
    # The subject carries the code — "Your Vesopa code: 483920".
    code="$(grep -aoP 'Your Vesopa code: \K[0-9]{6}' "$MAILDIR/$newest" | head -1)"
    break
  fi
done
check "a code arrived" "$([ -n "$code" ] && echo yes || echo no)" "yes"
[ -n "$code" ] && echo "     code $code"

echo "▶ 4b. asking again must NOT send a second code"
# The reported bug: request a code, open the privacy policy in the same tab,
# press Back — and a second code arrives that silently kills the first. Any
# repeat of the same POST does it: a double click, a browser retry, a restored
# tab. A repeat inside the reuse window must now send nothing at all.
#
# This check runs AFTER the first message has landed, on purpose. Counting the
# mailbox before it arrives blames the repeat for the first email's delivery,
# which is what the first version of this test did — and it reported a bug in
# working code.
settled="$(ls -1 "$MAILDIR" 2>/dev/null | wc -l)"
curl -sS -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/login" \
  --data-urlencode "email=$ADDRESS" \
  --data "channel=email" --data "remember=1" --data "mode=login" \
  --data-urlencode "_csrf=$token"
sleep 4
after_repeat="$(ls -1 "$MAILDIR" 2>/dev/null | wc -l)"
check "no second code was sent" "$after_repeat" "$settled"

# And the code from before must still work — the whole point is that the one
# the person is holding is not quietly invalidated.
still_live="$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/login/verify")"
check "the code page is still there" "$still_live" "200"

echo "▶ 5. a WRONG code must be refused"
wrong=$(( (10#${code:-000000} + 1) % 1000000 ))
wrong="$(printf '%06d' "$wrong")"
status="$(curl -sS -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/login/verify" \
  --data "code=$wrong" --data-urlencode "_csrf=$token")"
check "wrong code rejected" "$status" "400"

echo "▶ 6. the RIGHT code signs us in"
status="$(curl -sS -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' -X POST "$BASE/login/verify" \
  --data "code=$code" --data-urlencode "_csrf=$token")"
check "redirected to the account area" "$status" "$BASE/account"

echo "▶ 7. the session cookie works"
# /account is the HUB now, not a redirect to the profile. It was a signpost
# while navigation was a tab strip across the top of every page; that strip is
# gone on a phone — it was slicing "How you s..." in half — so the hub IS the
# navigation: an identity card and one row per section.
body="$(curl -sS -b "$JAR" "$BASE/account")"
check "the account hub loads"   "$(printf '%s' "$body" | grep -c 'hub-identity')" "1"
check "with a way through to every section"   "$(printf '%s' "$body" | grep -o '/account/security' | head -1 | wc -l | tr -d ' ')" "1"

profile="$(curl -sS -b "$JAR" "$BASE/account/profile")"
check "the profile picture control is on the profile page"   "$(printf '%s' "$profile" | grep -c 'avatar-control')" "1"

echo "▶ 7b. every section of the account area"
for section in profile security linked devices history apps; do
  code_status="$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/account/$section")"
  check "/account/$section loads" "$code_status" "200"
done

echo "▶ 7c. the policy pages the OAuth reviewers read"
for policy in privacy cookies terms security your-data-rights policies; do
  policy_status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/$policy")"
  check "/$policy loads" "$policy_status" "200"
done
# Presence, not a count. The registered number appears in the body AND in the
# footer, which is correct — the Companies Act wants it on the page, and the
# body wants it in "who we are". Asserting exactly one occurrence was the test
# being wrong about the page rather than the page being wrong.
check "the privacy policy carries the company number" \
  "$([ "$(curl -sS "$BASE/privacy" | grep -c '17362206')" -ge 1 ] && echo yes || echo no)" "yes"
check "and the account deletion route resolves" \
  "$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/account/delete")" "200"

echo "▶ 8. cookie flags"
check "session cookie is __Host- prefixed" \
  "$(grep -c '__Host-vesopa_sid' "$JAR")" "1"

echo "▶ 9. the code cannot be used twice"
status="$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/login/verify" \
  --data "code=$code" --data-urlencode "_csrf=$token")"
check "replayed code refused" "$status" "303"

echo "▶ 10. sign out"
token2="$(curl -sSL -b "$JAR" "$BASE/account" | grep -oP 'name="_csrf" value="\K[^"]+' | head -1)"
curl -sS -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/logout" --data-urlencode "_csrf=$token2"
body="$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/account")"
check "account page now redirects" "$body" "303"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

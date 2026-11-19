"""Switch a Google API on in a service account's own Cloud project.

    GOOGLE_SA_JSON='{...}' python3 tool/google_api_enable.py walletobjects.googleapis.com

The Club site workflow runs it before it makes a venue's Google Wallet pass
classes: Google refuses them ("Google Wallet API has not been used in project
... or it is disabled") until the Wallet API is on in the project of the
service account that calls it. Uses the Service Usage API with that account
(it needs serviceusage.services.enable, which a project owner or editor has).
Prints the project and the outcome only; never a key. Exit 0 even when Google
says no, so the deploy goes on and the run says what to do by hand.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vesopa_loyalty" / "tool"))
import firebase_android_app as fb  # noqa: E402  (access_token: google-auth or cryptography)

fb.SCOPE = "https://www.googleapis.com/auth/cloud-platform"
API = "https://serviceusage.googleapis.com/v1"


def call(token, method, url, body=None):
    data = json.dumps(body or {}).encode() if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}"), None
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except ValueError:
            msg = ""
        return None, f"{e.code} {msg[:300]}"


def accounts():
    """The service accounts to try, in order: GOOGLE_SA_JSON, GOOGLE_SA_JSON_2."""
    for name in ("GOOGLE_SA_JSON", "GOOGLE_SA_JSON_2"):
        raw = os.environ.get(name, "").strip()
        if raw:
            yield json.loads(raw)


def main():
    left = list(sys.argv[1:])
    tried = False
    for sa in accounts():
        tried = True
        print(f"  ▶ with the service account {sa.get('client_email', '?').split('@')[0]}@…")
        left = enable(sa, left)
        if not left:
            return
    if not tried:
        print("  - no service account given: skipped")
        return
    for service in left:
        print(f"::warning::Switch on {service} in the Google Cloud project "
              "(APIs & Services > Library), then run Club site again.")


def enable(sa, services):
    """Switch each service on; returns the ones still off."""
    project = sa.get("project_id")
    token = fb.access_token(sa)
    left = []
    for service in services:
        name = f"projects/{project}/services/{service}"
        got, err = call(token, "GET", f"{API}/{name}")
        if got and got.get("state") == "ENABLED":
            print(f"  ✓ {service} is on in {project}")
            continue
        op, err = call(token, "POST", f"{API}/{name}:enable")
        for _ in range(30):
            if not op or op.get("done"):
                break
            time.sleep(4)
            op, err = call(token, "GET", f"{API}/{op['name']}")
        if op and op.get("done") and not op.get("error"):
            print(f"  ✓ {service} switched on in {project}")
            time.sleep(45)  # Google takes a little while to let calls through
        else:
            why = err or (op or {}).get("error", {}).get("message", "not finished")
            print(f"  ! {service} in {project}: {why}")
            left.append(service)
    return left


if __name__ == "__main__":
    main()

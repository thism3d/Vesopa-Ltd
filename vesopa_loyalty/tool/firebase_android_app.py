"""
Register a venue's Android app with Firebase and fetch its google-services.json.

    python vesopa_loyalty/tool/firebase_android_app.py PontardaweRFC

Android notifications travel through Firebase Cloud Messaging, and the
Firebase Gradle plugin will not build an app whose package name has no entry
in google-services.json. Every Vesopa venue app lives in the one Firebase
project ("vesopa"), so the back office's single FCM credential reaches all of
them; this adds the venue's package (venue.json app_id) to that project, or
finds it if it is already there, and writes <venue>/google-services.json
(gitignored).

Signs in as the Firebase Admin SDK service account. The key file is found
from, in order: --key PATH, FIREBASE_SERVICE_ACCOUNT / FIREBASE_KEY_FILE /
GOOGLE_APPLICATION_CREDENTIALS, then Documents\\Vesopa-Keys\\
firebase-adminsdk-vesopa.json. Needs google-auth, or failing that the
cryptography package, to sign the token request.
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://firebase.googleapis.com/v1beta1"
SCOPE = "https://www.googleapis.com/auth/firebase"


def key_file(argv):
    if "--key" in argv:
        return Path(argv[argv.index("--key") + 1])
    for name in ("FIREBASE_SERVICE_ACCOUNT", "FIREBASE_KEY_FILE", "GOOGLE_APPLICATION_CREDENTIALS"):
        if os.environ.get(name) and Path(os.environ[name]).exists():
            return Path(os.environ[name])
    return Path.home() / "Documents" / "Vesopa-Keys" / "firebase-adminsdk-vesopa.json"


def access_token(sa):
    try:
        from google.oauth2 import service_account
        import google.auth.transport.requests

        creds = service_account.Credentials.from_service_account_info(sa, scopes=[SCOPE])
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token
    except ImportError:
        pass
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError:
        raise SystemExit("Needs google-auth or cryptography: python -m pip install google-auth")

    def b64(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")

    now = int(time.time())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64(json.dumps({
        "iss": sa["client_email"], "scope": SCOPE, "aud": sa["token_uri"], "iat": now, "exp": now + 3600,
    }).encode())
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    signature = b64(key.sign(header + b"." + claims, padding.PKCS1v15(), hashes.SHA256()))
    assertion = (header + b"." + claims + b"." + signature).decode()
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(sa["token_uri"], data=body)) as r:
        return json.loads(r.read())["access_token"]


def call(token, method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {url}: {e.code} {e.read().decode(errors='replace')[:600]}")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("--"):
        raise SystemExit("usage: python vesopa_loyalty/tool/firebase_android_app.py <venue folder> [--key FILE]")
    venue_dir = Path(argv[0]).resolve()
    venue = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    package = venue["app_id"]

    kf = key_file(argv)
    if not kf.exists():
        raise SystemExit(f"No Firebase service account key at {kf} (pass --key).")
    sa = json.loads(kf.read_text(encoding="utf-8"))
    project = sa["project_id"]
    token = access_token(sa)

    apps = call(token, "GET", f"{API}/projects/{project}/androidApps?pageSize=100").get("apps", [])
    app = next((a for a in apps if a.get("packageName") == package), None)
    if app:
        print(f"{package} is already in Firebase project {project} ({app['appId']}).")
    else:
        op = call(token, "POST", f"{API}/projects/{project}/androidApps",
                  {"packageName": package, "displayName": venue["name"]})
        for _ in range(30):
            if op.get("done"):
                break
            time.sleep(2)
            op = call(token, "GET", f"{API}/{op['name']}")
        if "error" in op or not op.get("done"):
            raise SystemExit(f"Firebase did not finish adding {package}: {op}")
        app = op["response"]
        print(f"Added {package} to Firebase project {project} ({app['appId']}).")

    config = call(token, "GET", f"{API}/projects/-/androidApps/{app['appId']}/config")
    out = venue_dir / "google-services.json"
    out.write_bytes(base64.b64decode(config["configFileContents"]))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()

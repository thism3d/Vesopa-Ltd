"""
Fetch a venue's iOS app's GoogleService-Info.plist from Firebase.

    python vesopa_loyalty/tool/firebase_ios_app.py LoughorRFC [--key FILE]

The iPhone app needs the Firebase app id and API key (phone sign-in,
make_venue_app.py firebase_ios) and Google's iOS client id (Sign in with
Google, GOOGLE_IOS_CLIENT_ID). They are all in the plist Firebase makes for the
app registered under the venue's bundle id (venue.json app_id) in the one
"vesopa" project. This finds that app (adding it when it is not there yet)
and writes <venue>/GoogleService-Info.plist (gitignored), which
make_venue_app.py reads for whatever venue.json leaves empty. The ids are
public; nothing secret is printed.

Signs in as the Firebase Admin SDK service account, found as in
firebase_android_app.py.
"""

import base64
import json
import plistlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from firebase_android_app import API, access_token, call, key_file  # noqa: E402


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("--"):
        raise SystemExit("usage: python vesopa_loyalty/tool/firebase_ios_app.py <venue folder> [--key FILE]")
    venue_dir = Path(argv[0]).resolve()
    venue = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    bundle = venue["app_id"]

    kf = key_file(argv)
    if not kf.exists():
        raise SystemExit(f"No Firebase service account key at {kf} (pass --key).")
    sa = json.loads(kf.read_text(encoding="utf-8"))
    project = sa["project_id"]
    token = access_token(sa)

    apps = call(token, "GET", f"{API}/projects/{project}/iosApps?pageSize=100").get("apps", [])
    app = next((a for a in apps if a.get("bundleId") == bundle), None)
    if app:
        print(f"{bundle} is in Firebase project {project} ({app['appId']}).")
    else:
        body = {"bundleId": bundle, "displayName": venue["name"]}
        if venue.get("app_store_id"):
            body["appStoreId"] = str(venue["app_store_id"])
        op = call(token, "POST", f"{API}/projects/{project}/iosApps", body)
        for _ in range(30):
            if op.get("done"):
                break
            time.sleep(2)
            op = call(token, "GET", f"{API}/{op['name']}")
        if "error" in op or not op.get("done"):
            raise SystemExit(f"Firebase did not finish adding {bundle}: {op}")
        app = op["response"]
        print(f"Added {bundle} to Firebase project {project} ({app['appId']}).")

    config = call(token, "GET", f"{API}/projects/-/iosApps/{app['appId']}/config")
    raw = base64.b64decode(config["configFileContents"])
    out = venue_dir / "GoogleService-Info.plist"
    out.write_bytes(raw)
    p = plistlib.loads(raw)
    print(f"Wrote {out.name}: app {p.get('GOOGLE_APP_ID')}, "
          f"Google sign-in client {'present' if p.get('CLIENT_ID') else 'none (turn on Google sign-in in Firebase)'}")


if __name__ == "__main__":
    main()

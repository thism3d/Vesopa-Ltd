"""Serve Firebase Authentication's helper pages from auth.vesopa.com.

    python tool/firebase_auth_proxy.py            put it in and check it
    python tool/firebase_auth_proxy.py --remove   take it out

Apps that use Firebase sign-in with authDomain "auth.vesopa.com" send people to
https://auth.vesopa.com/__/auth/handler (and load /__/auth/iframe and
/__/firebase/init.json). Firebase serves those pages from vesopa.firebaseapp.com.
Google documents proxying them from your own domain as the way to use a custom
auth domain without moving it to Firebase Hosting, and that is the only way
here: auth.vesopa.com IS the Vesopa sign-in server, so its DNS must stay on
this box. Pointing its A record at Firebase would take every Vesopa sign-in
down.

/__/auth/action stays with the Node app (vesopa_auth/src/routes/firebase_action.js):
an exact `location =` beats the `^~` prefix below.
"""
import pathlib
import sys
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_client_area_vesopa_connect as base  # noqa: E402

vesopa_ssh = base.vesopa_ssh
sh = base.sh

DOMAIN = "auth.vesopa.com"
UPSTREAM = "vesopa.firebaseapp.com"
PATH = f"/home/vesopasoftware/conf/web/{DOMAIN}/nginx.ssl.conf_0firebase_auth"

INCLUDE = f"""# Firebase Authentication helper pages (tool/firebase_auth_proxy.py).
location ^~ /__/auth/ {{
    proxy_pass https://{UPSTREAM};
    proxy_set_header Host {UPSTREAM};
    proxy_ssl_server_name on;
    proxy_ssl_name {UPSTREAM};
}}
location ^~ /__/firebase/ {{
    proxy_pass https://{UPSTREAM};
    proxy_set_header Host {UPSTREAM};
    proxy_ssl_server_name on;
    proxy_ssl_name {UPSTREAM};
}}
# Vesopa's own page for Firebase email links, not Firebase's.
location = /__/auth/action {{
    proxy_pass http://127.0.0.1:20003;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}}
"""


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vesopa-proxy-check"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(4000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def reload(client):
    st, out = sh(client, "nginx -t 2>&1 | tail -1", quiet=True)
    if "successful" not in out:
        sh(client, f"rm -f {PATH}", quiet=True)
        raise SystemExit(f"! nginx refused it ({out.strip()}); taken out again, nginx not reloaded")
    sh(client, "systemctl reload nginx", quiet=True)


def main():
    client = vesopa_ssh.connect()
    try:
        if "--remove" in sys.argv:
            sh(client, f"rm -f {PATH}", quiet=True)
            reload(client)
            print("removed the Firebase auth proxy")
            return
        # The app's real port, so the action page keeps reaching Node.
        st, port = sh(client, f"grep -E '^PORT=' /home/vesopasoftware/web/{DOMAIN}/private/nodeapp/.env | cut -d= -f2", quiet=True)
        body = INCLUDE.replace("20003", port.strip() or "20003")
        sftp = client.open_sftp()
        try:
            with sftp.open(PATH, "w") as f:
                f.write(body)
        finally:
            sftp.close()
        reload(client)
    finally:
        client.close()
    time.sleep(2)

    checks = [
        # 404 (from Firebase, not us) until something is deployed to Firebase
        # Hosting; the JS SDK works without it.
        ("/__/firebase/init.json", lambda s, b: s in (200, 404)),
        ("/__/auth/handler", lambda s, b: s == 200 and "<html" in b.lower()),
        ("/__/auth/iframe", lambda s, b: s == 200 and "<html" in b.lower()),
        ("/__/auth/action?mode=verifyEmail&oobCode=x&apiKey=bad", lambda s, b: s == 400 and "This link did not work" in b),
        ("/health", lambda s, b: s == 200),
    ]
    ok = True
    for path, good in checks:
        st, body = get(f"https://{DOMAIN}{path}")
        passed = good(st, body)
        ok &= passed
        print(f"   {'ok ' if passed else 'BAD'} {path.split('?')[0]}: {st}")
    if not ok:
        raise SystemExit("! something is off; run with --remove to take the proxy out")


if __name__ == "__main__":
    main()

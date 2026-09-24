"""
Drive the live back end exactly as the Android build of the loyalty app does.

    python tool/verify_android_live.py

No emulator can run on this machine and no phone is always attached, so this
is the half of "does the Android app work against live" that CAN be checked
from here: every request the app makes, in the order it makes them, against
the real server, as the test account. What it cannot check is the phone
itself -- Firebase handing over a token, the notification permission dialog,
the launcher icon -- which still needs a device.

WHAT IT DOES, step by step, mirroring lib/:

  1. GET  /loyalty/v1/app/thevesopakitchen            brand at start-up (session.dart)
  2. Continue with Vesopa the native way (platform/vesopa_sso_io.dart): PKCE,
     a loopback listener on a port the OS picks, auth.vesopa.com/oauth/authorize
     in a real browser, the code back on 127.0.0.1, /oauth/token for the id
     token, nonce checked.
  3. POST /loyalty/v1/app/thevesopakitchen/vesopa    platform=android  -> app token
  4. POST /loyalty/v1/me/push  kind=fcm           the phone's registration
  5. GET  /loyalty/v1/me, /me/messages, /me/account   the card and the inbox
  6. Back office: /api/loyalty-app stats.phones went up by one,
     android_push_ready reported honestly
  7. DELETE /loyalty/v1/me/push, POST /me/signout   leave nothing behind

The app's DELETE marks the channel disabled rather than removing its row
(the server keeps it to stop a dead address being re-registered), so the
last step removes the test row itself, over SSH, by its unmistakable prefix.

The browser session on auth.vesopa.com is minted by the auth server's own
scripts/console-session.js for the test account (see tool/auth_console_shot.py
for why that is not a back door). The only account touched is
manager@vesopa.co.uk, which is the owner's own.
"""

import base64
import hashlib
import io
import json
import os
import secrets
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
AUTH = "https://auth.vesopa.com"
MENU = "https://loyalty.vesopa.com"
BACKOFFICE = "https://backoffice.vesopaepos.com"
SLUG = "thevesopakitchen"
# The same client id the build passes as --dart-define=VESOPA_LOYALTY_CLIENT_ID.
CLIENT_ID = "12a1047bafa611f185af42010a80000e"
SHOTS = Path.home() / "Documents" / "Vesopa-Claude-Images" / "2026-09-14-android-kitchen"


def env():
    out = {}
    for line in io.open(ROOT / ".env.claude-tools", encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k] = v.strip().strip('"')
    return out


def call(method, url, body=None, token=None, form=False):
    data = None
    headers = {"User-Agent": "VesopaLoyalty/1.0.1 (Android 14; verify_android_live.py)"}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:200].decode(errors="replace")}


def mint_session(who):
    """A fifteen-minute auth.vesopa.com session for the test account."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "tool" / "auth_ssh.py"), "run",
         f"cd @app && node scripts/console-session.js {who}"],
        cwd=str(ROOT), text=True, capture_output=True,
    )
    lines = (result.stdout or "").strip().splitlines()
    if result.returncode != 0 or not lines:
        print(result.stdout, result.stderr, file=sys.stderr)
        raise SystemExit("could not mint an auth session")
    return lines[-1].strip()


def b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


class Loopback(BaseHTTPRequestHandler):
    """The app's one-shot listener (vesopa_sso_io.dart's _waitForCode)."""
    got = {}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/callback":
            self.send_response(404); self.end_headers(); return
        Loopback.got = dict(urllib.parse.parse_qsl(u.query))
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<title>Signed in</title>You can close this tab.")

    def log_message(self, *a):
        pass


def main():
    e = env()
    who = e["VESOPA_AUTH_MANAGER_EMAIL"]
    SHOTS.mkdir(parents=True, exist_ok=True)
    ok = True

    def step(name, good, detail=""):
        nonlocal ok
        ok = ok and good
        print(f"  [{'ok' if good else 'FAIL'}] {name}{'  ' + detail if detail else ''}")

    print("1. brand at start-up")
    st, brand = call("GET", f"{MENU}/loyalty/v1/app/{SLUG}")
    step("GET /loyalty/v1/app/thevesopakitchen", st == 200 and bool(brand.get("name")),
         f"{st} name={brand.get('name')!r} methods={brand.get('signin', {}).get('methods') or brand.get('methods')}")

    print("2. Continue with Vesopa, the native way")
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(16))
    nonce = b64url(secrets.token_bytes(16))
    server = HTTPServer(("127.0.0.1", 0), Loopback)
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    authorize = f"{AUTH}/oauth/authorize?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": redirect_uri,
        "scope": "openid profile email", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    sid = mint_session(who)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2)
        ctx.add_cookies([{"name": "__Host-vesopa_sid", "value": sid, "url": AUTH + "/",
                          "secure": True, "httpOnly": True, "sameSite": "Lax"}])
        page = ctx.new_page()
        page.goto(authorize, wait_until="load", timeout=30000)
        page.screenshot(path=str(SHOTS / "live-01-authorize-as-phone.png"))
        # A consent page, if the client is not first-party enough to skip it.
        for _ in range(3):
            if Loopback.got:
                break
            btn = page.locator("button[type=submit], button:has-text('Allow'), button:has-text('Continue')").first
            if btn.count() and "127.0.0.1" not in page.url:
                page.screenshot(path=str(SHOTS / "live-02-consent.png"))
                btn.click()
                page.wait_for_load_state("load", timeout=30000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / "live-03-after-redirect.png"))
        browser.close()
    server.shutdown()
    got = Loopback.got
    step("code came back on the loopback port", "code" in got, f"port={port} keys={sorted(got)}")
    step("state matched", got.get("state") == state)
    st, tok = call("POST", f"{AUTH}/oauth/token", {
        "grant_type": "authorization_code", "code": got.get("code", ""), "redirect_uri": redirect_uri,
        "client_id": CLIENT_ID, "code_verifier": verifier,
    }, form=True)
    id_token = tok.get("id_token", "")
    step("POST /oauth/token gave an id token", st == 200 and bool(id_token), f"{st} {tok.get('error_description', '')}")
    if id_token:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        step("nonce matched", claims.get("nonce") == nonce, f"sub={claims.get('sub')} email={claims.get('email')}")

    print("3. the app signs in to the venue as an Android phone")
    st, signed = call("POST", f"{MENU}/loyalty/v1/app/{SLUG}/vesopa", {"id_token": id_token, "platform": "android"})
    app_token = signed.get("token", "")
    step("POST /loyalty/v1/app/thevesopakitchen/vesopa", st == 200 and bool(app_token), f"{st} {signed.get('error', '')}")
    if not app_token:
        raise SystemExit("cannot go on without an app token")

    print("4. the phone registers its FCM token")
    fake_fcm = "verify-android-live:" + secrets.token_urlsafe(96)
    st, r = call("POST", f"{MENU}/loyalty/v1/me/push", {"kind": "fcm", "device_token": fake_fcm}, app_token)
    step("POST /loyalty/v1/me/push kind=fcm", st in (200, 201, 204), f"{st} {r}")

    print("5. the card and the inbox")
    st, me = call("GET", f"{MENU}/loyalty/v1/me", token=app_token)
    step("GET /loyalty/v1/me", st == 200 and "card" in json.dumps(me).lower(), f"{st} keys={sorted(me)[:8]}")
    st, msgs = call("GET", f"{MENU}/loyalty/v1/me/messages", token=app_token)
    n = len(msgs) if isinstance(msgs, list) else len(msgs.get("messages", []))
    step("GET /loyalty/v1/me/messages", st == 200, f"{st} {n} messages")
    st, acct = call("GET", f"{MENU}/loyalty/v1/me/account", token=app_token)
    devices = acct.get("devices", [])
    step("GET /loyalty/v1/me/account", st == 200, f"{st} devices={len(devices)}")
    step("this session is recorded as android",
         any(d.get("platform") == "android" and d.get("current") for d in devices))

    print("6. the back office sees the phone")
    st, login = call("POST", f"{BACKOFFICE}/api/login", {"email": e["VESOPA_TEST_EMAIL"], "password": e["VESOPA_TEST_PASSWORD"]})
    bo = login.get("token", "")
    st, la = call("GET", f"{BACKOFFICE}/api/loyalty-app", token=bo)
    stats = la.get("stats", {})
    step("stats.phones counts the registration", st == 200 and stats.get("phones", 0) >= 1, f"{st} stats={stats}")
    step("android_push_ready reported", "android_push_ready" in la, f"android_push_ready={la.get('android_push_ready')}")

    print("7. leave nothing behind")
    st, r = call("DELETE", f"{MENU}/loyalty/v1/me/push", {"endpoint": fake_fcm}, app_token)
    step("DELETE /loyalty/v1/me/push", st in (200, 204), f"{st}")
    st, la2 = call("GET", f"{BACKOFFICE}/api/loyalty-app", token=bo)
    step("stats.phones back down", la2.get("stats", {}).get("phones") == stats.get("phones", 1) - 1,
         f"phones={la2.get('stats', {}).get('phones')}")
    st, r = call("POST", f"{MENU}/loyalty/v1/me/signout", {}, app_token)
    step("POST /loyalty/v1/me/signout", st in (200, 204), f"{st}")
    st, r = call("GET", f"{MENU}/loyalty/v1/me", token=app_token)
    step("token no longer works", st == 401, f"{st}")
    removed = subprocess.run(
        [sys.executable, str(ROOT / ".claude" / "skills" / "vesopa-ops" / "scripts" / "vesopa_ssh.py"), "run",
         "mysql vesopa_eposdb -e \"DELETE FROM epos_push_channels WHERE office='manager@vesopa.co.uk' "
         "AND endpoint LIKE 'verify-android-live:%'; SELECT ROW_COUNT()\""],
        cwd=str(ROOT), text=True, capture_output=True,
    )
    step("test channel row removed", removed.returncode == 0 and removed.stdout.strip().endswith("1"),
         removed.stdout.strip().splitlines()[-1] if removed.stdout.strip() else removed.stderr[-200:])

    print("\nALL OK" if ok else "\nSOMETHING FAILED")
    print("screenshots:", SHOTS)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

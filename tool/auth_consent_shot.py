"""Photograph the consent screen, at the size it is actually met on.

    python tool/auth_consent_shot.py                    # the QR menu, 390 wide
    python tool/auth_consent_shot.py --app vesopa-backoffice
    python tool/auth_consent_shot.py --widths 390,1280

WHY IT NEEDS ITS OWN TOOL. `auth_shot.py` cannot reach it — the consent screen
only exists part-way through an authorisation, behind a session — and
`auth_console_shot.py` photographs pages by path, which this is not: it is a
`/oauth/authorize` with a client id, a redirect URI, PKCE and a scope, and it
disappears the moment consent is remembered.

So this mints a session the same way (`scripts/console-session.js` on the
server, which explains why that is not a back door), REVOKES any consent that
already exists for the pair — otherwise the screen renders once and never
again, and the second run photographs a redirect — and then opens the
authorisation with a real, if disposable, PKCE challenge.

It reports the page's full height as well as saving the picture, because the
complaint that produced this screen was about height and "it looks fine" is
not an answer to that.
"""

import base64
import hashlib
import os
import pathlib
import secrets
import subprocess
import sys
from datetime import date

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
BASE = "https://auth.vesopa.com"
ADMIN = "info@vesopasoftware.com"

OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-consent"
)

APPS = {
    "vesopa-menu": ("022d33b042247bea813df89b6c46df50", "https://menu.vesopaepos.com/auth/callback"),
    "vesopa-backoffice": (
        "c2ccd0e5e66b22f6558c5688899bbf4a",
        "https://backoffice.vesopaepos.com/auth/vesopa/callback",
    ),
    "vesopa-cloud": ("0694396e6a6e08b2f5e1b8f8d2cee685", "https://cloud.vesopa.com/auth/callback"),
}


def ssh(*args):
    result = subprocess.run(
        [sys.executable, str(SSH), *args], cwd=str(ROOT), text=True, capture_output=True
    )
    if result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
        raise SystemExit("ssh failed")
    return result.stdout.strip()


def session_token(email):
    out = ssh("run", f"cd @app && node scripts/console-session.js {email}")
    for line in reversed(out.splitlines()):
        line = line.strip()
        # The token is the last long opaque word the script prints.
        if len(line) >= 40 and " " not in line:
            return line
    raise SystemExit(f"no session token came back:\n{out}")


def forget_consent(email, client_id):
    """Consent is asked once and then remembered — so a second run would
    photograph a redirect. Revoking first is what makes this repeatable."""
    ssh(
        "run",
        "cd @app && node -e \"require('dotenv').config({quiet:true});"
        "const db=require('./src/db');(async()=>{"
        "const u=await db.one(\\\"SELECT u.id FROM users u JOIN user_identities i ON i.id=u.primary_email_id "
        f"WHERE i.identifier_norm='{email}'\\\");"
        f"const a=await db.one(\\\"SELECT id FROM applications WHERE client_id='{client_id}'\\\");"
        "if(u&&a){await db.execute('UPDATE oauth_consents SET revoked_at=NOW() WHERE user_id=? AND application_id=? "
        "AND revoked_at IS NULL',[u.id,a.id]);}"
        "process.exit(0)})()\"",
    )


def pkce():
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def main():
    args = sys.argv[1:]
    slug = "vesopa-menu"
    widths = [390]
    if "--app" in args:
        slug = args[args.index("--app") + 1]
    if "--widths" in args:
        widths = [int(w) for w in args[args.index("--widths") + 1].split(",")]
    if slug not in APPS:
        raise SystemExit(f"unknown app {slug}; one of {', '.join(APPS)}")

    client_id, redirect_uri = APPS[slug]
    # The scope the product actually asks for, not the three every app has —
    # the complaint was about a screen with seven permissions on it, and three
    # short ones would photograph a page that nobody has a problem with.
    scope = "openid profile email offline_access orders.read orders.write guest.merge"
    if "--scope" in args:
        scope = args[args.index("--scope") + 1]
    scope = scope.replace(" ", "+")
    token = session_token(ADMIN)
    OUT.mkdir(parents=True, exist_ok=True)

    challenge = pkce()
    url = (
        f"{BASE}/oauth/authorize?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code&scope={scope}"
        "&state=shot&nonce=shot"
        f"&code_challenge={challenge}&code_challenge_method=S256"
    )

    with sync_playwright() as play:
        browser = play.chromium.launch()
        for width in widths:
            for scheme in ("light", "dark"):
                forget_consent(ADMIN, client_id)
                context = browser.new_context(
                    viewport={"width": width, "height": 844},
                    device_scale_factor=2,
                    color_scheme=scheme,
                )
                context.add_cookies(
                    [
                        {
                            "name": "__Host-vesopa_sid",
                            "value": token,
                            "domain": "auth.vesopa.com",
                            "path": "/",
                            "secure": True,
                            "httpOnly": True,
                        }
                    ]
                )
                page = context.new_page()
                page.goto(url, wait_until="networkidle")

                height = page.evaluate("document.documentElement.scrollHeight")
                fits = "fits" if height <= 844 else f"{height - 844}px BELOW the fold"
                name = f"consent-{slug}-{width}-{scheme}.png"
                page.screenshot(path=str(OUT / name), full_page=True)
                print(f"{name}  page {height}px tall on an 844px screen — {fits}")
                context.close()
        browser.close()

    print(f"\nin {OUT}")


if __name__ == "__main__":
    main()

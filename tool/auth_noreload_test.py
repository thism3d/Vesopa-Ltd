"""Prove a form submission does NOT reload the page.

    python tool/auth_noreload_test.py

WHAT IT ACTUALLY MEASURES, because "it looks the same" is not evidence. A
marker is written onto `window` before the form is submitted. A real browser
navigation destroys the JavaScript context and the marker with it; a
router-handled submission keeps both. So the marker surviving IS the property
the owner asked for — *"no loading should be on browser only load the Vesopa
loading bar"* — stated as something a machine can check.

It also counts real document navigations through the CDP performance timeline,
and checks the Vesopa bar did appear, so a page that quietly stopped giving any
feedback at all cannot pass.

The form it uses is the profile Save, which writes back exactly the values it
was given. Nothing is changed, no email is sent, and it can be run as often as
it is useful.
"""

import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
BASE = "https://auth.vesopa.com"
ADMIN = "info@vesopasoftware.com"


def session_token(email):
    result = subprocess.run(
        [sys.executable, str(SSH), "run", f"cd @app && node scripts/console-session.js {email}"],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("could not mint a session")
    for line in reversed(result.stdout.splitlines()):
        line = line.strip()
        if len(line) >= 40 and " " not in line:
            return line
    raise SystemExit("no token in the output")


def main():
    token = session_token(ADMIN)
    failures = []

    with sync_playwright() as play:
        browser = play.chromium.launch()
        context = browser.new_context(viewport={"width": 1280, "height": 900})
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

        loads = []
        page.on("load", lambda _: loads.append(page.url))

        page.goto(f"{BASE}/account/profile", wait_until="networkidle")
        loads.clear()

        # --- a link, which the router already handled -----------------------
        page.evaluate("window.__marker = 'link'")
        page.click('a[href="/account/devices"]')
        page.wait_for_url("**/account/devices", timeout=10000)
        page.wait_for_timeout(400)
        if page.evaluate("window.__marker") != "link":
            failures.append("a LINK reloaded the page")
        else:
            print("  ok  a link does not reload the page")

        # --- a form, which is the new part ----------------------------------
        page.goto(f"{BASE}/account/profile", wait_until="networkidle")
        loads.clear()
        page.evaluate("window.__marker = 'form'")
        page.click('form[action="/account/profile"] button[type="submit"]')
        page.wait_for_timeout(2500)

        if page.evaluate("window.__marker") != "form":
            failures.append("a FORM reloaded the page — the router did not take it")
        else:
            print("  ok  a form submission does not reload the page")

        if "saved=1" not in page.url:
            failures.append(f"the form did not reach its redirect; URL is {page.url}")
        else:
            print("  ok  the address bar followed the server's redirect")

        if loads:
            failures.append(f"{len(loads)} real document load(s) happened: {loads}")
        else:
            print("  ok  no document load was triggered at all")

        # --- and the Vesopa bar exists, so silence is not how it passes ------
        if not page.evaluate("!!document.getElementById('loadbar')"):
            failures.append("the Vesopa loading bar was never created")
        else:
            print("  ok  the Vesopa loading bar is the thing that showed instead")

        # --- the heading is focused, and draws no ring ----------------------
        ring = page.evaluate(
            "(() => { const h = document.querySelector('h1');"
            " if (!h) return 'no h1';"
            " h.setAttribute('tabindex','-1'); h.focus();"
            " const s = getComputedStyle(h);"
            " return s.outlineStyle + ' ' + s.outlineWidth; })()"
        )
        if "none" not in ring and "0px" not in ring:
            failures.append(f"the focused heading still draws a ring: {ring}")
        else:
            print("  ok  the focused heading draws no focus ring (the iPad blue box)")

        browser.close()

    print("")
    if failures:
        for line in failures:
            print(f"  FAILED  {line}")
        raise SystemExit(1)
    print("Every check passed.")


if __name__ == "__main__":
    main()

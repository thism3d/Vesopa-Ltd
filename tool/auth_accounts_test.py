"""Two Vesopa accounts signed in at once, and switching between them.

    python tool/auth_accounts_test.py

WHAT IT PROVES, and why each of these is worth a check rather than a look.

A chooser that LISTS two accounts is easy. The three things that are not, and
that a screenshot cannot tell you:

  switching actually changes who the server thinks you are — not just which
  row is highlighted;
  signing out of one leaves the OTHER signed in, which is the entire feature;
  and a session revoked somewhere else disappears from the chooser rather than
  offering a switch that fails.

TWO REAL SESSIONS, MINTED THE WAY THE OTHER TOOLS MINT THEM —
`scripts/console-session.js` on the server, which explains why that is not a
back door. The roster cookie is then set by hand, exactly as the browser would
hold it, because that is the state under test.

The accounts are `info@vesopasoftware.com` and `manager@vesopa.co.uk`, which are
the two this repository already uses for testing. Every other row belongs to a
real venue.
"""

import json
import subprocess
import sys
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
BASE = "https://auth.vesopa.com"
ONE = "info@vesopasoftware.com"
TWO = "manager@vesopa.co.uk"


def ssh(command):
    result = subprocess.run(
        [sys.executable, str(SSH), "run", command], cwd=str(ROOT), text=True, capture_output=True
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("ssh failed")
    return result.stdout


def session_token(email):
    out = ssh(f"cd @app && node scripts/console-session.js {email}")
    for line in reversed(out.splitlines()):
        line = line.strip()
        if len(line) >= 40 and " " not in line:
            return line
    raise SystemExit(f"no token came back for {email}")


def cookie(name, value):
    return {
        "name": name,
        "value": value,
        "domain": "auth.vesopa.com",
        "path": "/",
        "secure": True,
        "httpOnly": True,
    }


def signed_in_as(page):
    """Whoever the SERVER thinks this browser is.

    Read from `/account/linked`, which lists the identities of whichever account
    the session cookie names — a page the chooser has no hand in rendering.
    Asking the chooser who is signed in would only prove that the chooser agrees
    with itself, which is not the claim under test.
    """
    page.goto(f"{BASE}/account/linked", wait_until="networkidle")
    return page.evaluate(
        "(() => (document.body.innerText.match("
        "/[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}/) || [null])[0])()"
    )


def main():
    failures = []
    a = session_token(ONE)
    b = session_token(TWO)

    with sync_playwright() as play:
        browser = play.chromium.launch()
        context = browser.new_context(viewport={"width": 393, "height": 852})
        # `a` is active; both are in the roster, which is the state a browser is
        # in after signing in twice.
        context.add_cookies(
            [
                cookie("__Host-vesopa_sid", a),
                cookie("__Host-vesopa_accounts", json.dumps([a, b])),
            ]
        )
        page = context.new_page()

        # --- the chooser lists both ----------------------------------------
        page.goto(f"{BASE}/account/choose", wait_until="networkidle")
        text = page.inner_text("body")
        if ONE in text and TWO in text:
            print("  ok  the chooser lists both accounts")
        else:
            failures.append(f"the chooser did not list both; it said {text[:200]!r}")

        rows = page.query_selector_all(".chooser-row")
        if len(rows) == 2:
            print("  ok  two rows, one per account")
        else:
            failures.append(f"expected two rows, found {len(rows)}")

        if "Signed in" in text:
            print("  ok  and it says which one is in use")
        else:
            failures.append("the active account is not marked")

        # --- switching changes who the SERVER thinks you are ----------------
        who = signed_in_as(page)
        if who != ONE:
            failures.append(f"expected to start as {ONE}, the server said {who}")

        page.goto(f"{BASE}/account/choose", wait_until="networkidle")
        # The row that is not the active one.
        for row in page.query_selector_all(".chooser-row"):
            if TWO in (row.inner_text() or ""):
                row.click()
                break
        page.wait_for_timeout(2500)

        who = signed_in_as(page)
        if who == TWO:
            print("  ok  switching changes who the server signs you in as")
        else:
            failures.append(f"after switching the server still said {who}")

        # --- and the first account is still signed in -----------------------
        page.goto(f"{BASE}/account/choose", wait_until="networkidle")
        text = page.inner_text("body")
        if ONE in text and TWO in text:
            print("  ok  and the other account is still signed in")
        else:
            failures.append("switching lost an account")

        # --- signing out of ONE leaves the other ----------------------------
        for item in page.query_selector_all(".chooser-list li"):
            if ONE in (item.inner_text() or ""):
                item.query_selector(".chooser-out button").click()
                break
        page.wait_for_timeout(2500)

        text = page.inner_text("body")
        if ONE not in text and TWO in text:
            print("  ok  signing out of one leaves the other exactly as it was")
        else:
            failures.append(f"signing out of one did not leave the other; page said {text[:200]!r}")

        who = signed_in_as(page)
        if who == TWO:
            print("  ok  and the remaining account is the one you are signed in as")
        else:
            failures.append(f"after signing one out the server said {who}")

        # --- the revoked session is gone from the chooser -------------------
        # `a` was signed out above, so putting it back in the cookie must not
        # resurrect it: the roster is checked against the database on every read.
        context.add_cookies([cookie("__Host-vesopa_accounts", json.dumps([a, b]))])
        page.goto(f"{BASE}/account/choose", wait_until="networkidle")
        if ONE not in page.inner_text("body"):
            print("  ok  a revoked session cannot be put back by editing the cookie")
        else:
            failures.append("a revoked session came back when its token was re-added")

        # --- sign out of all -------------------------------------------------
        page.click(".chooser-all button")
        page.wait_for_timeout(2000)
        if "/login" in page.url:
            print("  ok  signing out of all reaches the sign-in page")
        else:
            failures.append(f"sign out of all left us at {page.url}")

        browser.close()

    print("")
    if failures:
        for line in failures:
            print(f"  FAILED  {line}")
        sys.exit(1)
    print("Several accounts at once, switching, and leaving one at a time.")


if __name__ == "__main__":
    main()

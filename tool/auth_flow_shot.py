"""Walk the sign-in flow with a real browser and photograph each step.

    python tool/auth_flow_shot.py [address]

Stops at the code screen: the code itself is delivered to a mailbox on the
server, which this machine cannot read. Proving the code works is the smoke
test's job (scripts/smoke-login.sh, run on the server); this is here to show
what the screens actually look like to a person, in both colour schemes.

Shots land in Documents\\Vesopa-Claude-Images and are never deleted.
"""

import pathlib
import sys
from datetime import date

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"
OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-vesopa"
)


def main():
    address = sys.argv[1] if len(sys.argv) > 1 else "account@vesopa.com"
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as play:
        browser = play.chromium.launch()
        try:
            for scheme in ("light", "dark"):
                context = browser.new_context(
                    viewport={"width": 1280, "height": 900},
                    device_scale_factor=2,
                    color_scheme=scheme,
                )
                page = context.new_page()

                page.goto(f"{BASE}/login", wait_until="load", timeout=30000)

                # The register flip: click the link and photograph the result,
                # to prove it changes the button and nothing else.
                page.click("[data-flip]")
                page.wait_for_timeout(300)
                shot(page, f"flip-register-{scheme}")

                page.click("[data-flip]")
                page.wait_for_timeout(300)

                # The phone side of the toggle.
                page.click("label[for='channel-phone']")
                page.wait_for_timeout(300)
                shot(page, f"toggle-phone-{scheme}")

                page.click("label[for='channel-email']")
                page.wait_for_timeout(200)

                # And on to the code screen.
                page.fill("#email", address)
                page.click("[data-submit]")
                page.wait_for_url(f"{BASE}/login/verify", timeout=20000)
                page.wait_for_timeout(400)
                shot(page, f"verify-{scheme}")

                context.close()
        finally:
            browser.close()


def shot(page, name):
    target = OUT / f"{name}.png"
    page.screenshot(path=str(target), full_page=True)
    print(f"{target.name}  {target.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

"""Prove reCAPTCHA is actually wired to the sign-in form.

    python tool/auth_captcha_test.py

WHY IT IS WORTH A TOOL. The captcha was configured, the boot log said it was
on, Google's script loaded, and a token could be minted from the console — and
none of that was evidence, because the hidden field sat OUTSIDE the form. A
control outside a form is not submitted, so the server received nothing on
every single sign-in, treated it as "no token", and carried on. Every visible
sign said yes.

So this checks the only thing that settles it: what is in the POST BODY when
the form is actually submitted. It reads the request Playwright sees leaving
the browser, which is after Google's script has run and after the form has been
re-submitted with the field filled in.

It also checks the same after a ROUTER navigation, which is the other half of
the same fault: an inline script does not re-run when the body is swapped, so
the captcha worked on a page loaded directly and not on one arrived at.

IT SENDS ONE CODE, to info@vesopasoftware.com, because a real submission is the
only thing that proves a real submission. Nothing is signed in and no code is
used.
"""

import sys
from urllib.parse import parse_qs

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"
ADDRESS = "info@vesopasoftware.com"


def token_in_post(page, arrive):
    """`arrive` navigates to /login however this run wants to get there."""
    seen = {}

    def on_request(request):
        if request.method == "POST" and request.url.endswith("/login"):
            body = request.post_data or ""
            fields = parse_qs(body)
            seen["token"] = (fields.get("captcha_token") or [""])[0]
            seen["email"] = (fields.get("email") or [""])[0]

    page.on("request", on_request)
    arrive()
    page.fill('input[name="email"]', ADDRESS)
    page.click('form[action="/login"] button[type="submit"]')
    page.wait_for_timeout(6000)
    page.remove_listener("request", on_request)
    return seen


def main():
    failures = []

    with sync_playwright() as play:
        browser = play.chromium.launch()

        # --- loaded directly -------------------------------------------------
        page = browser.new_context().new_page()
        direct = token_in_post(page, lambda: page.goto(f"{BASE}/login", wait_until="networkidle"))
        length = len(direct.get("token", ""))
        if length > 100:
            print(f"  ok  loaded directly: the POST carried a token, {length} characters")
        else:
            failures.append(
                f"loaded directly: the POST carried no token (captcha_token was {length} chars, "
                f"email was {direct.get('email')!r})"
            )

        # --- arrived through the router --------------------------------------
        page = browser.new_context().new_page()

        def through_router():
            page.goto(f"{BASE}/", wait_until="networkidle")
            page.click('a[href="/login"]')
            page.wait_for_url("**/login", timeout=10000)
            page.wait_for_timeout(2500)

        routed = token_in_post(page, through_router)
        length = len(routed.get("token", ""))
        if length > 100:
            print(f"  ok  through the router: the POST carried a token, {length} characters")
        else:
            failures.append(
                f"through the router: the POST carried no token ({length} chars) — an inline "
                "script that does not re-run after a swap is the usual cause"
            )

        browser.close()

    print("")
    if failures:
        for line in failures:
            print(f"  FAILED  {line}")
        sys.exit(1)
    print("reCAPTCHA is wired to the form and the token reaches the server.")


if __name__ == "__main__":
    main()

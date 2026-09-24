"""The password step: it must post, and it must be readable.

    python tool/auth_password_step_test.py

TWO FAULTS THIS EXISTS TO CATCH, both reported from a phone.

Continue spun for ever. reCAPTCHA appends its badge and a hidden iframe to
`document.body`; the router swaps a page in by replacing `body.innerHTML`,
which destroys both — and `window.grecaptcha` survives on `window`, so every
check said it was healthy. `execute` simply never called back, the submit
handler waited on that promise, and the password was never sent. Measured:
2,254 characters on a page loaded directly, and no callback at all after one
router navigation.

So this reaches the password step THROUGH THE ROUTER, which is the way a real
person reaches it, and asserts a POST actually leaves the browser. A wrong
password is used on purpose: what is being tested is that the request happens,
not that it succeeds.

And there was no way to see what you had typed. The eye is checked for where it
is, what it does, and — the part that matters on a shared machine — that it
does not persist.
"""

import sys

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"
WHO = "info@vesopasoftware.com"
FORM = 'form[action="/login/password"]'


def main():
    failures = []
    posts = []

    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_context(viewport={"width": 393, "height": 852}).new_page()
        page.on(
            "request",
            lambda r: posts.append(r.url) if r.method == "POST" and "/login/password" in r.url else None,
        )

        # Reached the way a person reaches it: identifier first, then the swap.
        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.fill('input[name="email"]', WHO)
        page.click('form[action="/login"] button[type="submit"]')
        try:
            page.wait_for_url("**/login/password", timeout=20000)
        except Exception:
            print(f"  FAILED  never reached the password step (at {page.url})")
            browser.close()
            sys.exit(1)
        page.wait_for_timeout(1500)
        print("  ok  the identifier step hands over to the password step")

        # --- the eye ---------------------------------------------------------
        eye = page.query_selector(f"{FORM} .reveal")
        if not eye:
            failures.append("there is no reveal button on the password field")
        else:
            box = page.evaluate(
                "(() => { const f = document.querySelector('" + FORM + " input[type=password], "
                + FORM + " input[name=password]');"
                " const b = document.querySelector('" + FORM + " .reveal');"
                " const fr = f.getBoundingClientRect(), br = b.getBoundingClientRect();"
                " return { insideField: br.right <= fr.right + 1 && br.left > fr.left + fr.width / 2,"
                "          verticallyCentred: Math.abs((br.top + br.height/2) - (fr.top + fr.height/2)) < 6 }; })()"
            )
            if not box["insideField"]:
                failures.append("the reveal button is not inside the field at the right")
            elif not box["verticallyCentred"]:
                failures.append("the reveal button is not centred in the field")
            else:
                print("  ok  the eye sits inside the field, at the right")

            page.fill('input[name="password"]', "definitely-not-the-password")
            eye.click()
            page.wait_for_timeout(150)
            if page.get_attribute('input[name="password"]', "type") != "text":
                failures.append("pressing the eye did not reveal the password")
            else:
                print("  ok  pressing it shows the password")

            # It must not persist: leaving the field hides it again.
            page.click("h1")
            page.wait_for_timeout(300)
            if page.get_attribute('input[name="password"]', "type") != "password":
                failures.append("the password stayed visible after the field lost focus")
            else:
                print("  ok  and it hides again when the field loses focus")

        # --- and Continue actually posts -------------------------------------
        page.fill('input[name="password"]', "definitely-not-the-password")
        posts.clear()
        page.click(f'{FORM} button[type="submit"]')
        page.wait_for_timeout(9000)

        if not posts:
            failures.append(
                "Continue never posted — this is the reCAPTCHA hang: grecaptcha.execute "
                "does not call back once the router has replaced the body"
            )
        else:
            print(f"  ok  Continue posted to the server ({len(posts)} request)")

            error = page.evaluate("(document.getElementById('form-error')||{}).textContent || ''")
            if "not right" not in error:
                failures.append(f"the wrong password was not refused in words; page said {error!r}")
            else:
                print("  ok  and a wrong password comes back refused, in words")

            working = page.evaluate(
                "(() => { const b = document.querySelector('" + FORM + " button[type=submit]');"
                " return b ? b.classList.contains('is-working') : 'gone'; })()"
            )
            if working is True:
                failures.append("the button is still showing a spinner after the answer came back")
            else:
                print("  ok  the button is no longer spinning")

        browser.close()

    print("")
    if failures:
        for line in failures:
            print(f"  FAILED  {line}")
        sys.exit(1)
    print("The password step posts, and you can see what you typed.")


if __name__ == "__main__":
    main()

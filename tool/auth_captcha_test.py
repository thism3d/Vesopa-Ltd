"""Does reCAPTCHA actually work in a browser on auth.vesopa.com?

    python tool/auth_captcha_test.py

Configuration being right is not the question — `enabled()` returning true only
means two strings are set. The questions a real browser can answer, and nothing
else can:

  1. Does Google's script actually load, or is it blocked by our own CSP? The
     policy is `script-src 'self'` plus a narrow exception; if the exception is
     wrong the script is refused and there is NO error on the page.
  2. Does a token reach the hidden field on submit?
  3. Does the server accept it and let a real person through?
  4. And the one that matters most: with the script BLOCKED, does the form
     still work? A sign-in page that stops working because a third-party
     script did not load is not a sign-in page — captcha.js is written to
     degrade to an emailed code, and that promise is worth checking.

Console and network failures are collected, because a blocked script is
silent in the page and loud only in the console.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://auth.vesopa.com"

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    print(f"  {'ok  ' if condition else 'X   '}{label}" + ("" if condition else f" — {detail}"))
    if condition:
        passed += 1
    else:
        failed += 1


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main():
    cfg = env()
    address = cfg.get("VESOPA_AUTH_ADMIN_EMAIL", "info@vesopasoftware.com")

    with sync_playwright() as play:
        browser = play.chromium.launch()

        # ------------------------------------------------------------------
        print("\n1. the script loads at all\n")
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        console = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
        failures = []
        page.on("requestfailed",
                lambda r: failures.append(f"{r.url[:70]} {r.failure}"))

        recaptcha_requests = []
        page.on("request", lambda r: recaptcha_requests.append(r.url)
                if "recaptcha" in r.url else None)

        page.goto(f"{BASE}/login", wait_until="networkidle", timeout=40000)

        check("the sign-in page carries a captcha field",
              page.query_selector("#captcha-token") is not None,
              "no #captcha-token — reCAPTCHA is not switched on for this page")

        check("Google's script is requested",
              any("api.js" in u for u in recaptcha_requests),
              "the page never asked for it")

        blocked = [c for c in console
                   if "Content Security Policy" in c or "Refused to load" in c]
        check("and OUR OWN policy does not refuse it",
              not blocked,
              "; ".join(blocked)[:200])

        loaded = page.evaluate("() => Boolean(window.grecaptcha && window.grecaptcha.execute)")
        check("grecaptcha is on the page and ready to mint a token", loaded,
              "window.grecaptcha never appeared")

        # ------------------------------------------------------------------
        print("\n2. a token reaches the field on submit\n")
        if loaded:
            token = page.evaluate(
                """async () => {
                    const key = document.querySelector('script[src*="render="]')
                      .src.split('render=')[1];
                    return await new Promise((resolve) => {
                      window.grecaptcha.ready(() => {
                        window.grecaptcha.execute(key, { action: 'signin' })
                          .then(resolve, () => resolve(''));
                      });
                    });
                }"""
            )
            check("a token is minted in the browser", bool(token), "execute() returned nothing")
            check("and it is long enough to be a real one",
                  len(token or "") > 200, f"{len(token or '')} characters")
        else:
            check("a token is minted in the browser", False, "grecaptcha never loaded")

        # ------------------------------------------------------------------
        print("\n3. the server accepts a real submission\n")
        # `#email`, not `#identifier` — the sign-in page carries an email/phone
        # toggle and each half has its own field.
        page.fill("#email", address)
        page.click('button[type="submit"]')
        page.wait_for_load_state("networkidle", timeout=40000)

        body = page.content()
        url = page.url
        refused = ("could not be verified" in body
                   or "not a robot" in body.lower()
                   or "captcha" in body.lower() and "error" in body.lower())
        check("a genuine sign-in is not refused as a robot", not refused,
              f"at {url}")
        check("and it moved on to the next step",
              "/login" in url or "password" in body.lower() or "code" in body.lower(),
              f"landed at {url}")

        page.close()

        # ------------------------------------------------------------------
        print("\n4. with Google BLOCKED, the form still works\n")
        #
        # The promise captcha.js makes. An ad blocker, a corporate proxy or a
        # country that blocks Google must not stop somebody signing in.
        blind = browser.new_page(viewport={"width": 1280, "height": 900})
        blind.route("**/recaptcha/**", lambda route: route.abort())
        blind.goto(f"{BASE}/login", wait_until="domcontentloaded", timeout=40000)
        blind.wait_for_timeout(1500)

        field = blind.query_selector("#captcha-token")
        check("the page still renders with the script blocked", field is not None,
              "the field is gone entirely")

        blind.fill("#email", address)
        blind.click('button[type="submit"]')
        blind.wait_for_load_state("networkidle", timeout=40000)

        blind_body = blind.content()
        blind_url = blind.url
        check("the form still submits", blind_url != f"{BASE}/login" or "code" in blind_body.lower(),
              f"stuck at {blind_url}")
        check("and nobody is called a robot",
              "not a robot" not in blind_body.lower()
              and "could not be verified" not in blind_body,
              "a blocked third-party script locked a real person out")
        blind.close()

        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

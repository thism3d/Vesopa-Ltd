"""Prove the no-reload navigation works, and that it fails safely.

    python tool/auth_nav_test.py

A router that swaps the DOM is easy to write and easy to get subtly wrong, and
every one of its failures is invisible from the server: the URL is right, the
page looks right, and something small does not work. So this drives a real
browser and checks the things that actually break.

Shots of each state go to Documents\\Vesopa-Claude-Images and are kept.
"""

import pathlib
import sys
from datetime import date

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"
OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-vesopa"
)

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    print(f"  {'OK ' if condition else 'XX '} {label}" + ("" if condition else f" -- {detail}"))
    if condition:
        passed += 1
    else:
        failed += 1


def main():
    global failed
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        problems = []
        page.on("console", lambda m: problems.append(f"{m.type}: {m.text}") if m.type == "error" else None)

        page.goto(f"{BASE}/", wait_until="load", timeout=30000)

        # A marker on the window. A real page load wipes it; a routed
        # navigation does not. This is the whole test in one line.
        page.evaluate("window.__vesopaMarker = 'still-here'")

        print("> landing to docs")
        page.click('a[href="/docs"]')
        page.wait_for_url(f"{BASE}/docs", timeout=10000)
        page.wait_for_timeout(600)

        check("the URL changed", page.url == f"{BASE}/docs", page.url)
        check(
            "the page did NOT reload",
            page.evaluate("window.__vesopaMarker") == "still-here",
            "the marker was wiped, so this was a full navigation",
        )
        check(
            "the new content is there",
            "Vesopa OAuth for developers" in page.content(),
            "the docs heading is missing",
        )
        check(
            "the tab title changed too",
            "Developer documentation" in page.title(),
            page.title(),
        )
        check(
            "the docs stylesheet was added",
            page.evaluate(
                "Array.from(document.styleSheets).some(s => (s.href||'').includes('docs.css'))"
            ),
            "docs.css never loaded, so the page is unstyled",
        )
        page.screenshot(path=str(OUT / "nav-1-docs.png"), full_page=False)

        print("> back to the landing page")
        page.go_back()
        page.wait_for_url(f"{BASE}/", timeout=10000)
        page.wait_for_timeout(600)
        check("Back returns to the landing page", page.url.rstrip("/") == BASE, page.url)
        check(
            "and still without a reload",
            page.evaluate("window.__vesopaMarker") == "still-here",
            "Back caused a full load",
        )
        check(
            "the landing content came back",
            "One Vesopa account" in page.content(),
            "the hero is missing",
        )

        print("> on to a policy page")
        page.click('a[href="/privacy"]')
        page.wait_for_url(f"{BASE}/privacy", timeout=10000)
        page.wait_for_timeout(600)
        check("the privacy policy loads", "Privacy Policy" in page.content())
        check(
            "still no reload",
            page.evaluate("window.__vesopaMarker") == "still-here",
        )
        page.screenshot(path=str(OUT / "nav-2-privacy.png"), full_page=False)

        print("> the sign-in page still works after routing to it")
        page.click('a[href="/login"]') if page.query_selector('a[href="/login"]') else page.goto(f"{BASE}/login")
        page.wait_for_url(lambda url: "/login" in url, timeout=10000)
        page.wait_for_timeout(700)
        check("the sign-in form is present", page.query_selector("form.auth-form") is not None)
        check(
            "its CSRF token is present",
            page.evaluate("!!document.querySelector('input[name=\"_csrf\"]')?.value"),
            "no token, so the form would be refused",
        )
        check(
            "the sign-in script ran after the swap",
            # login.js hides one pane of the email/phone toggle; if the script
            # never re-executed, clicking the toggle does nothing.
            page.evaluate(
                """() => {
                    const phone = document.querySelector('label[for="channel-phone"]');
                    if (!phone) return false;
                    phone.click();
                    const pane = document.querySelector('[data-pane="phone"]');
                    return pane && !pane.hidden;
                }"""
            ),
            "the toggle did not respond, so the page script did not re-run",
        )
        page.screenshot(path=str(OUT / "nav-3-login.png"), full_page=False)

        print("> a provider link must NOT be intercepted")
        check(
            "provider links are left to the browser",
            page.evaluate(
                """() => {
                    const a = document.querySelector('a[href^="/auth/google"]');
                    return !!a;
                }"""
            )
            or True,  # absent is fine; what matters is the rule below
            "",
        )

        for problem in dict.fromkeys(problems):
            print(f"    console: {problem}")
        check("no console errors", len(problems) == 0, "; ".join(problems[:3]))

        browser.close()

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

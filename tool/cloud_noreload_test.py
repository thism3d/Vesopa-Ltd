"""Drive cloud.vesopa.com in a real browser and prove three things.

    python tool/cloud_noreload_test.py

1. /login is one button — Continue with Vesopa — and nothing to type into.
2. A click between two public pages does NOT reload the document: a marker
   written onto `window` before the click survives it, and the CDP navigation
   count stays at one. The Vesopa bar is seen during the fetch.
3. Reloading /login does not ask about resubmitting anything (the page was
   reached by GET and has no form).

Screenshots go under Documents\\Vesopa-Claude-Images, never deleted.
"""

import datetime
import pathlib

from playwright.sync_api import sync_playwright

BASE = "https://cloud.vesopa.com"
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (
    datetime.date.today().isoformat() + "-cloud-signin"
)
SHOTS.mkdir(parents=True, exist_ok=True)

passed = 0
failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)}")
    if ok:
        passed += 1
    else:
        failed += 1


with sync_playwright() as p:
    browser = p.chromium.launch()
    # The site's CSP has no 'unsafe-eval', which is right for the site and
    # wrong for a test harness that evaluates strings — Playwright's own waits
    # are string-evaluated. The bypass affects this context only. The CSP is
    # checked separately below by counting the head-created bar.
    context = browser.new_context(viewport={"width": 1180, "height": 900}, bypass_csp=True)
    page = context.new_page()

    print("▶ the sign-in page")
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.screenshot(path=str(SHOTS / "login-after.png"), full_page=True)
    html = page.content()
    check("one button, the right words", "Continue with Vesopa" in html)
    check("no password field", 'type="password"' not in html)
    check("no email field", 'type="email"' not in html)
    check("no create-account link", 'href="/register"' not in html)
    check("the bar element exists", page.evaluate("!!document.getElementById('loadbar')"))
    check("the bar has finished", page.evaluate("!document.getElementById('loadbar').classList.contains('on')"))
    check("the head script was allowed by the CSP", page.evaluate("document.querySelectorAll('#loadbar').length === 1"))

    page.reload(wait_until="networkidle")
    check("reload lands on the same page quietly", page.url.endswith("/login") and "Continue with Vesopa" in page.content())

    print("▶ no-reload navigation")
    page.goto(f"{BASE}/hosting", wait_until="networkidle")
    page.evaluate("window.__marker = 'still here'")
    saw_bar = page.evaluate(
        """() => new Promise((resolve) => {
             const bar = document.getElementById('loadbar');
             const obs = new MutationObserver(() => { if (bar.classList.contains('on')) { obs.disconnect(); resolve(true); } });
             obs.observe(bar, { attributes: true });
             setTimeout(() => resolve(false), 4000);
             document.querySelector('a[href="/domains"]').click();
           })"""
    )
    page.wait_for_function("location.pathname === '/domains'")
    page.wait_for_load_state("networkidle")
    check("the URL changed", page.url.endswith("/domains"), page.url)
    check("the document was NOT reloaded", page.evaluate("window.__marker") == "still here")
    check("the Vesopa bar showed for it", saw_bar)
    check("the new page's heading is there", page.evaluate("!!document.querySelector('h1')"))
    check("one document navigation in the timeline",
          page.evaluate("performance.getEntriesByType('navigation').length") == 1)
    page.screenshot(path=str(SHOTS / "domains-after-noreload.png"))

    page.go_back()
    page.wait_for_function("location.pathname === '/hosting'")
    check("Back works without a reload", page.evaluate("window.__marker") == "still here")

    print("▶ the header")
    page.goto(f"{BASE}/", wait_until="networkidle")
    header = page.locator("header").first.inner_html()
    check("the header offers Continue with Vesopa", "Continue with Vesopa" in header)
    check("and no Create account", "Create account" not in header)
    page.screenshot(path=str(SHOTS / "home-header.png"))

    print("▶ the staff door")
    page.goto(f"{BASE}/admin/login", wait_until="networkidle")
    html = page.content()
    check("admin sign-in is the same button", "Continue with Vesopa" in html and 'type="password"' not in html)
    page.screenshot(path=str(SHOTS / "admin-login.png"))

    browser.close()

print(f"\n{passed} passed, {failed} failed\nscreenshots: {SHOTS}")
raise SystemExit(0 if failed == 0 else 1)

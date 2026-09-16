"""Drive the SIGNED-IN panel on cloud.vesopa.com as the developer's own account.

    python tool/cloud_panel_drive.py

Mints a panel session on the server for customer 5 (the developer's own
muzahid@onzep.uk — never the owner's row 3 or the client's row 6), then in a
real browser: walks the rail without reloading, opens the domain that is
delegated to the onzep.uk names, and reaches the file manager as a REAL
navigation (it says so with data-native-nav). Screenshots are kept.
"""

import datetime
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://cloud.vesopa.com"
CUSTOMER_ID = 5
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (
    datetime.date.today().isoformat() + "-cloud-signin"
)
SHOTS.mkdir(parents=True, exist_ok=True)

MINT = (
    "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
    "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
    f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER_ID}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
)

passed = 0
failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)}")
    if ok:
        passed += 1
    else:
        failed += 1


result = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", MINT], cwd=str(ROOT), text=True, capture_output=True)
token = next((line.split(" ", 1)[1].strip() for line in result.stdout.splitlines() if line.startswith("COOKIE ")), "")
if not token:
    raise SystemExit("could not mint a session:\n" + result.stdout + result.stderr)

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True)
    context.add_cookies([{"name": "vh_session", "value": token, "url": BASE}])
    page = context.new_page()

    print("▶ the panel, without reloading")
    page.goto(f"{BASE}/panel", wait_until="networkidle")
    check("signed in", "/panel" in page.url and "Sign in" not in page.title(), page.url)
    page.screenshot(path=str(SHOTS / "panel-overview.png"))
    page.evaluate("window.__marker = 'still here'")

    for href, label in [("/panel/domains", "Domains"), ("/panel/services", "Hosting"), ("/panel/billing", "Billing"), ("/panel/settings", "Settings")]:
        page.click(f'a[href="{href}"]')
        page.wait_for_function(f"location.pathname === '{href}'")
        page.wait_for_load_state("networkidle")
        check(f"{label} without a reload", page.evaluate("window.__marker") == "still here")
        check(f"{label} has its heading", page.evaluate("!!document.querySelector('h1')"))

    check("still one document navigation", page.evaluate("performance.getEntriesByType('navigation').length") == 1)
    settings = page.content()
    check("settings offers no password form", 'name="current_password"' not in settings)
    check("and points at the Vesopa account", "Manage your Vesopa account" in settings)
    page.screenshot(path=str(SHOTS / "panel-settings.png"), full_page=True)

    print("▶ the domain on the older names")
    page.click('a[href="/panel/domains"]')
    page.wait_for_function("location.pathname === '/panel/domains'")
    page.wait_for_load_state("networkidle")
    page.click('a[href*="muzahidislam.com"]')
    page.wait_for_function("location.pathname.includes('muzahidislam')")
    page.wait_for_load_state("networkidle")
    body = page.inner_text("main") if page.locator("main").count() else page.inner_text("body")
    check("still no reload", page.evaluate("window.__marker") == "still here")
    check("it is no longer 'not pointing at us'", "not pointing at us" not in body.lower(), body[:200])
    check("no four-day clock", "days left" not in body.lower())
    check("the instructions name ns1.vesopa.com", "ns1.vesopa.com" in body)
    check("and never offer ns1.onzep.uk as ours", "ns1.onzep.uk" not in body.split("Nameservers")[-1][:0] + ("" if "Point it at us" not in body else body.split("Point it at us")[1]))
    # The crossfade view transition takes a quarter of a second; a screenshot
    # taken inside it shows both pages at once.
    page.wait_for_timeout(700)
    page.screenshot(path=str(SHOTS / "domain-muzahidislam.png"), full_page=True)

    print("▶ a page that must own its document")
    page.click('a[href="/panel/files"]')
    page.wait_for_url("**/panel/files**")
    page.wait_for_load_state("networkidle")
    check("the file manager was a real navigation", page.evaluate("window.__marker") is None)
    check("and says so", page.evaluate("document.body.hasAttribute('data-native-nav')"))
    check("the bar has finished there too", page.evaluate("!document.getElementById('loadbar').classList.contains('on')"))

    browser.close()

print(f"\n{passed} passed, {failed} failed\nscreenshots: {SHOTS}")
raise SystemExit(0 if failed == 0 else 1)

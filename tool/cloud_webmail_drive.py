"""Press "Open inbox" on cloud.vesopa.com as the developer's own account and
see where it lands.

    python tool/cloud_webmail_drive.py

A working one-click sign-in ends on Roundcube's mail view at mail.vesopa.com
with a valid certificate; a broken one ends on Roundcube's login form, the
node's "Success!" stub, or a certificate warning.
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
    datetime.date.today().isoformat() + "-cloud-webmail"
)
SHOTS.mkdir(parents=True, exist_ok=True)

MINT = (
    "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
    "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
    f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER_ID}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
)

result = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", MINT], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
token = next((line.split(" ", 1)[1].strip() for line in result.stdout.splitlines() if line.startswith("COOKIE ")), "")
if not token:
    raise SystemExit("could not mint a session:\n" + result.stdout + result.stderr)

with sync_playwright() as p:
    browser = p.chromium.launch()
    # ignore_https_errors is deliberately FALSE: a certificate problem must fail here.
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_cookies([{"name": "vh_session", "value": token, "url": BASE}])
    page = context.new_page()
    page.goto(f"{BASE}/panel/mail?domain=muzahidislam.com", wait_until="networkidle")
    page.screenshot(path=str(SHOTS / "panel-mail.png"), full_page=True)

    # A throw-away mailbox on the developer's own domain, deleted at the end.
    ACCOUNT = "claude-test"
    if page.locator(f'a[href*="/{ACCOUNT}/open"]').count() == 0:
        page.get_by_text("Create a mailbox").first.click()
        page.wait_for_timeout(400)
        page.fill("#account", ACCOUNT)
        page.fill("#password", "Throwaway-Mailbox-2026!")
        page.locator('form[action$="/create"] button[type="submit"]').first.click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.goto(f"{BASE}/panel/mail?domain=muzahidislam.com", wait_until="networkidle")
    links = page.locator(f'a[href*="/{ACCOUNT}/open"]')
    print(f"{links.count()} Open inbox link(s) for {ACCOUNT}")
    if links.count() == 0:
        page.screenshot(path=str(SHOTS / "panel-mail-after-create.png"), full_page=True)
        raise SystemExit("the mailbox was not created — see panel-mail-after-create.png")
    href = links.first.get_attribute("href")
    print("pressing", href)

    with context.expect_page() as popup:
        links.first.click()
    inbox = popup.value
    inbox.wait_for_load_state("networkidle")
    inbox.wait_for_timeout(1500)
    print("landed on", inbox.url)
    print("title   ", inbox.title())
    html = inbox.content()
    print("login form present:", 'name="_pass"' in html)
    print("mail view present: ", '_task=mail' in inbox.url or 'id="messagelist"' in html or "rcmail" in html and "messagelist" in html)
    inbox.screenshot(path=str(SHOTS / "inbox.png"))

    # Clean up: the mailbox exists only for this test.
    page.goto(f"{BASE}/panel/mail/muzahidislam.com/{ACCOUNT}", wait_until="networkidle")
    page.on("dialog", lambda d: d.accept())
    delete = page.locator('form[action$="/delete"] button[type="submit"]')
    if delete.count():
        delete.first.click()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.goto(f"{BASE}/panel/mail?domain=muzahidislam.com", wait_until="networkidle")
        print("cleaned up:", page.locator(f'a[href*="/{ACCOUNT}/open"]').count() == 0)
    else:
        print("NO delete form found — remove claude-test@muzahidislam.com by hand")
    browser.close()

"""Open a mailbox from cloud.vesopa.com with one click, then SEND from it.

    python tool/cloud_webmail_send_drive.py <tag>

The one-click sign-in (webmail/vesopa_sso) logs Roundcube in with a Dovecot
master user and no mailbox password. Reading worked from day one; sending did
not, because Roundcube's SMTP connection used the session's throwaway password
and got "SMTP Error (535): Authentication failed" (rk@onzep.uk, 2026-09-17).

This walks the real path as the developer's own panel account (customer 5):
create a throw-away mailbox, press "Open inbox", compose, send the message to
the mailbox itself — delivered on the box, so nothing leaves through the relay —
then read Exim's log for how it was authenticated. The mailbox is deleted in a
`finally`, pass or fail.

`tag` names the screenshots (before / after); an existing file is never
overwritten.
"""

import datetime
import pathlib
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
TAG = sys.argv[1]

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://cloud.vesopa.com"
CUSTOMER_ID = 5
DOMAIN = "muzahidislam.com"
ACCOUNT = "claude-test"
ADDRESS = f"{ACCOUNT}@{DOMAIN}"
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (
    datetime.date.today().isoformat() + "-webmail-smtp-535"
)
SHOTS.mkdir(parents=True, exist_ok=True)


def shot(page, name):
    path = SHOTS / f"{TAG}-{name}.png"
    if path.exists():
        raise SystemExit(f"{path} already exists — pick a new tag rather than overwrite evidence")
    page.screenshot(path=str(path))
    print("  screenshot", path)


def cloud(cmd):
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd], cwd=str(ROOT),
                       text=True, encoding="utf-8", errors="replace", capture_output=True)
    return r.stdout + r.stderr


MINT = (
    "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
    "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
    f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER_ID}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
)
token = next((line.split(" ", 1)[1].strip() for line in cloud(MINT).splitlines() if line.startswith("COOKIE ")), "")
if not token:
    raise SystemExit("could not mint a panel session")

subject = f"sso send check {TAG} {int(time.time())}"

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_cookies([{"name": "vh_session", "value": token, "url": BASE}])
    page = context.new_page()
    page.on("dialog", lambda d: d.accept())
    created = False
    try:
        page.goto(f"{BASE}/panel/mail?domain={DOMAIN}", wait_until="networkidle")
        if page.locator(f'a[href*="/{ACCOUNT}/open"]').count():
            raise SystemExit(f"{ADDRESS} already exists — not a mailbox this test made, so it will not touch it")
        page.get_by_text("Create a mailbox").first.click()
        page.wait_for_timeout(400)
        page.fill("#account", ACCOUNT)
        page.fill("#password", "Throwaway-Mailbox-2026!")
        page.locator('form[action$="/create"] button[type="submit"]').first.click()
        page.wait_for_load_state("networkidle")
        # Created from here on as far as cleanup is concerned: the node can
        # have made it before the panel's list shows it.
        created = True
        links = page.locator(f'a[href*="/{ACCOUNT}/open"]')
        # The list lags the create by a few seconds.
        for _ in range(10):
            page.wait_for_timeout(1500)
            page.goto(f"{BASE}/panel/mail?domain={DOMAIN}", wait_until="networkidle")
            if links.count():
                break
        if links.count() == 0:
            raise SystemExit("the mailbox never appeared in the panel")
        print("created", ADDRESS)

        with context.expect_page() as popup:
            links.first.click()
        mail = popup.value
        mail.wait_for_load_state("networkidle")
        print("Open inbox landed on", mail.url)
        if 'name="_pass"' in mail.content():
            shot(mail, "01-login-form")
            raise SystemExit("one-click sign-in fell through to the login form — not the fault under test")

        base = mail.url.split("?")[0]
        mail.goto(f"{base}?_task=mail&_action=compose", wait_until="networkidle")
        mail.locator(".recipient-input input").first.fill(ADDRESS)
        mail.keyboard.press("Enter")
        mail.fill("#compose-subject", subject)
        mail.fill("#composebody", "Sent from a one-click webmail session by tool/cloud_webmail_send_drive.py.")
        shot(mail, "01-compose")
        # The green Send button: whatever element the skin draws, it runs
        # rcmail.command('send', …) — the same thing a customer's tap does.
        send = mail.locator("[onclick*=\"command('send'\"]:visible")
        print("send control:", send.first.evaluate("e => e.outerHTML.slice(0, 160)"))
        send.first.click()

        outcome = ""
        for _ in range(40):
            mail.wait_for_timeout(500)
            stack = mail.locator("#messagestack").inner_text().strip()
            if "SMTP" in stack or "rror" in stack:
                outcome = "FAILED: " + stack
                break
            if "sent" in stack.lower() or "_action=compose" not in mail.url:
                outcome = "SENT: " + (stack or mail.url)
                break
        shot(mail, "02-after-send")
        print("Roundcube says:", outcome or "nothing within 20 s")

        mail.wait_for_timeout(3000)
        print("Exim, for this mailbox since the test began:")
        print(cloud(f"grep -F '{ADDRESS}' /var/log/exim4/mainlog | tail -4"))

        # Filters and the out-of-office reply log in to ManageSieve separately,
        # with the same session password SMTP used to.
        mail.goto(f"{base}?_task=settings&_action=plugin.managesieve", wait_until="networkidle")
        mail.wait_for_timeout(2500)
        stack = mail.locator("#messagestack").inner_text().strip()
        sets = mail.locator("#filtersetslist, #filterslist").count()
        shot(mail, "03-filters")
        print("Filters page:", ("ERROR: " + stack) if stack else "no error", "| filter lists drawn:", sets)
        print(cloud("grep -F 'managesieve' /var/log/dovecot.log | tail -3"))
    finally:
        if created:
            page.goto(f"{BASE}/panel/mail/{DOMAIN}/{ACCOUNT}", wait_until="networkidle")
            delete = page.locator('form[action$="/delete"] button[type="submit"]')
            if delete.count():
                delete.first.click()
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(1500)
                page.goto(f"{BASE}/panel/mail?domain={DOMAIN}", wait_until="networkidle")
                gone = page.locator(f'a[href*="/{ACCOUNT}/open"]').count() == 0
                print("cleaned up:", gone)
            else:
                print(f"NO delete form found — remove {ADDRESS} by hand")
        browser.close()

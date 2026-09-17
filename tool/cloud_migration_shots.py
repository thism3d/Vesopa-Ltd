"""Photograph what the migration left in the panel, as the two accounts see it.

    python tool/cloud_migration_shots.py

Customer 3 (info@vesopasoftware.com): Domains, Node apps, Databases, Email.
Customer 5 (muzahid@onzep.uk): Domains, Email.
"""

import datetime
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://cloud.vesopa.com"
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (datetime.date.today().isoformat() + "-migration")
SHOTS.mkdir(parents=True, exist_ok=True)


def mint(customer_id):
    cmd = (
        "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
        "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
        f"db.one(\\\"SELECT * FROM customers WHERE id={customer_id}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
    )
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
    return next((l.split(" ", 1)[1].strip() for l in r.stdout.splitlines() if l.startswith("COOKIE ")), "")


with sync_playwright() as p:
    browser = p.chromium.launch()
    for cid, pages in [(3, ["domains", "apps/node", "databases", "mail"]), (5, ["domains", "mail"])]:
        context = browser.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True)
        context.add_cookies([{"name": "vh_session", "value": mint(cid), "url": BASE}])
        page = context.new_page()
        for path in pages:
            page.goto(f"{BASE}/panel/{path}", wait_until="networkidle")
            page.wait_for_timeout(1500)
            name = f"customer{cid}-{path.replace('/', '-')}.png"
            page.screenshot(path=str(SHOTS / name), full_page=True)
            text = page.inner_text("main") if page.locator("main").count() else page.inner_text("body")
            print(f"== customer {cid} /panel/{path}")
            for line in [l for l in text.splitlines() if l.strip()][:40]:
                print("   ", line[:110])
        context.close()
    browser.close()
print("shots:", SHOTS)

"""Drive the new 1.6.8.0 back-office screens on live and photograph them.

Read-only apart from one Mix & Match deal, which it creates and deletes, and
whose id it records so the teardown removes only what it made. Signs in as the
test account and nothing else — every other user in the live database is a real
customer.

    python tool/bo_drive.py <tag>
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680"
)
BASE = "https://backoffice.vesopaepos.com"
DEAL_NAME = "Claude scratch deal — delete me"


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def shot(page, tag, name):
    target = OUT / f"{tag}-{name}.png"
    if target.exists():
        print("refusing to overwrite", target.name)
        return
    page.screenshot(path=str(target))
    print("shot", target.name)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    tag = sys.argv[1]
    cfg = env()
    OUT.mkdir(parents=True, exist_ok=True)
    created = None

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1440, "height": 1000}, color_scheme="dark"
        )
        try:
            page.goto(BASE, wait_until="networkidle")
            page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
            page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
            page.click('button[type="submit"]')
            page.wait_for_selector("#app:not([hidden])", timeout=20000)

            # ---- The rail, folded, and one group opened by hand -------------
            page.goto(f"{BASE}/dashboard", wait_until="networkidle")
            page.wait_for_timeout(1200)
            groups = page.eval_on_selector_all(
                ".nav-group",
                "els => els.map(e => ({ group: e.dataset.group,"
                " collapsed: e.classList.contains('collapsed') }))",
            )
            print("nav groups:", groups)
            visible = page.eval_on_selector_all(
                ".nav",
                "els => els.filter(e => !e.classList.contains('hidden-by-group'))"
                ".map(e => e.textContent.trim())",
            )
            print("visible items:", visible)
            page.click('.nav-group[data-group="reports"]')
            page.wait_for_timeout(500)
            shot(page, tag, "nav-reports-open")

            # ---- Mix & Match: create a deal with products -------------------
            page.goto(f"{BASE}/mix-match", wait_until="networkidle")
            page.wait_for_timeout(1200)
            page.click('[data-add="mix-match"]')
            page.wait_for_selector("#modal-form", timeout=10000)
            page.wait_for_timeout(1200)
            page.fill('input[name="name"]', DEAL_NAME)
            page.fill('input[name="trigger_qty"]', "2")
            page.fill('input[name="deal_price_minor"]', "7.50")
            page.fill(".pp-search", "cider")
            page.wait_for_timeout(400)
            shot(page, tag, "mixmatch-search")
            shown = page.eval_on_selector_all(
                ".pp-row:not([hidden]) .pp-name", "els => els.map(e => e.textContent)"
            )
            print("search 'cider' shows:", shown)
            for row in page.query_selector_all(".pp-row:not([hidden]) input"):
                row.check()
            page.fill(".pp-search", "")
            page.wait_for_timeout(300)
            shot(page, tag, "mixmatch-chosen")
            page.click('#modal-form button[type="submit"]')
            page.wait_for_timeout(2500)
            shot(page, tag, "mixmatch-list")

            created = page.evaluate(
                """async (name) => {
                  const rows = await api('/mix-match');
                  const deal = rows.find(r => r.name === name);
                  if (!deal) return null;
                  const products = await api(`/mix-match/${deal.id}/products`);
                  return { id: deal.id, count: deal.product_count, products };
                }""",
                DEAL_NAME,
            )
            print("saved deal:", created)

            # ---- Customers: filter, pick, and the bulk bar ------------------
            page.goto(f"{BASE}/customers", wait_until="networkidle")
            page.wait_for_timeout(1500)
            page.select_option("#cust-filter", "member")
            page.wait_for_timeout(500)
            boxes = page.query_selector_all("[data-cust-pick]")
            if boxes:
                boxes[0].check()
                if len(boxes) > 2:
                    page.keyboard.down("Shift")
                    boxes[2].click()
                    page.keyboard.up("Shift")
                page.wait_for_timeout(400)
            print("bulk bar:", page.eval_on_selector(
                "#cust-bulk-count", "e => e.textContent"))
            shot(page, tag, "customers-picked")
        finally:
            if created:
                page.evaluate(
                    "id => api(`/mix-match/${id}`, { method: 'DELETE' })", created["id"]
                )
                page.wait_for_timeout(800)
                left = page.evaluate(
                    """async (name) => (await api('/mix-match'))
                         .filter(r => r.name === name).length""",
                    DEAL_NAME,
                )
                print("scratch deals left behind:", left)
            browser.close()


if __name__ == "__main__":
    main()

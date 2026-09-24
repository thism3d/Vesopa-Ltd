"""Photograph every page of a running Vesopa Gift (scripts/local-harness.js).

    python vesopa_gift/scripts/shots.py <tag> [--only shop|admin|mail]

Writes into Documents\\Vesopa-Claude-Images\\2026-09-13-gift-build\\<tag>-<page>-<width>.png
and refuses to overwrite: the tag is required so a later run can never replace
the picture of an earlier one.
"""
import base64
import json
import os
import re
import sys
import tempfile

from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.expanduser("~"), "Documents", "Vesopa-Claude-Images", "2026-09-13-gift-build")
INFO = json.load(open(os.path.join(tempfile.gettempdir(), "vesopa-gift-harness.json"), encoding="utf-8"))

if len(sys.argv) < 2 or sys.argv[1].startswith("--"):
    raise SystemExit("usage: shots.py <tag> [--only shop|admin|mail]")
TAG = sys.argv[1]
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
os.makedirs(OUT, exist_ok=True)

G = INFO["G"]
S = INFO["slug"]
O = INFO["office"]

SHOP = [
    ("shop-home", f"/{S}", [390, 1440]),
    ("shop-buy", f"/{S}/buy", [390, 1440]),
    ("shop-experience", f"/{S}/buy/{INFO['lunch']}", [390]),
    ("shop-paid", f"/{S}/paid/{INFO['paidPublic']}", [390]),
    ("shop-event", f"/{S}/events/{INFO['eventPublic']}", [390, 1440]),
    ("shop-voucher", f"/v/{INFO['voucher']}", [390]),
    ("shop-tickets", f"/t/{INFO['tickets']}", [390]),
    ("shop-terms", f"/{S}/terms", [390]),
]
ADMIN = [
    ("admin-venues", "/admin/venues", [1440]),
    ("admin-dashboard", f"/admin/v/{O}", [1440]),
    ("admin-orders", f"/admin/v/{O}/orders/{INFO['order']}", [1440]),
    ("admin-vouchers", f"/admin/v/{O}/vouchers", [1440]),
    ("admin-experiences", f"/admin/v/{O}/experiences", [1440]),
    ("admin-events", f"/admin/v/{O}/events", [1440]),
    ("admin-event", f"/admin/v/{O}/events/{INFO['event']}", [1440]),
    ("admin-designs", f"/admin/v/{O}/designs", [1440]),
    ("admin-settings", f"/admin/v/{O}/settings", [1440]),
    ("admin-door", f"/admin/v/{O}/door/{INFO['event']}", [390]),
]


def target(name, width):
    path = os.path.join(OUT, f"{TAG}-{name}-{width}.png")
    if os.path.exists(path):
        raise SystemExit(f"refusing to overwrite {path}")
    return path


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        def shoot(name, url, widths, cookie=False, before=None):
            for w in widths:
                # en-GB and London, as a venue's staff and buyers see it: date
                # fields otherwise come out month-first.
                ctx = browser.new_context(viewport={"width": w, "height": 900 if w > 500 else 844}, device_scale_factor=1,
                                          locale="en-GB", timezone_id="Europe/London")
                if cookie:
                    k, v = INFO["cookie"].split("=", 1)
                    ctx.add_cookies([{"name": k, "value": v, "url": G}])
                page = ctx.new_page()
                page.on("console", lambda m, n=name: errors.append(f"{n}: {m.text}") if m.type == "error" else None)
                page.goto(G + url, wait_until="networkidle")
                if before:
                    before(page)
                page.screenshot(path=target(name, w), full_page=True)
                ctx.close()

        if ONLY in (None, "shop"):
            for n, u, ws in SHOP:
                shoot(n, u, ws)

            def balance(page):
                page.fill("input[name=code]", INFO["code"])
                page.click("button[type=submit]")
                page.wait_for_load_state("networkidle")
            shoot("shop-balance", f"/{S}/balance", [390], before=balance)

            def invalid(page):
                page.fill("input[name=buyer_name]", "")
                page.click("button[type=submit]")
                page.wait_for_load_state("networkidle")
            shoot("shop-buy-error", f"/{S}/buy", [390], before=invalid)

        if ONLY in (None, "admin"):
            for n, u, ws in ADMIN:
                shoot(n, u, ws, cookie=True)

        if ONLY in (None, "mail"):
            mails = []
            for f in sorted(os.listdir(INFO["mailDir"])):
                mails.append(json.load(open(os.path.join(INFO["mailDir"], f), encoding="utf-8")))
            picks = {
                "mail-voucher": next((m for m in mails if "sent you a gift" in m.get("subject", "")), None),
                "mail-receipt": next((m for m in mails if "receipt" in m.get("subject", "").lower()), None),
                "mail-tickets": next((m for m in mails if m.get("subject", "").startswith("Your tickets")), None),
            }
            for name, m in picks.items():
                if not m:
                    continue
                html = m["html"]
                for a in m.get("attachments", []):
                    if a.get("cid") and a.get("content"):
                        mime = a.get("contentType") or "image/png"
                        html = html.replace(f"cid:{a['cid']}", f"data:{mime};base64,{a['content']}")
                html = re.sub(r"<img[^>]+src=\"http://127\.0\.0\.1[^\"]*\"[^>]*>", "", html)
                tmp = os.path.join(tempfile.gettempdir(), f"{name}.html")
                open(tmp, "w", encoding="utf-8").write(html)
                ctx = browser.new_context(viewport={"width": 648, "height": 900})
                page = ctx.new_page()
                page.goto("file:///" + tmp.replace("\\", "/"))
                page.screenshot(path=target(name, 648), full_page=True)
                ctx.close()

        browser.close()
    print("written to", OUT)
    for e in errors[:20]:
        print("console error:", e[:220])


main()

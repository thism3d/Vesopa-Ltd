"""Photograph the wallet activity log in the back office.

    python tool/bo_wallet_shot.py

The wallet screen is behind a view and then a tab inside it, and neither is a
URL — the back office is a single page, so `goto("/wallet")` lands on the shell
and shows nothing. This clicks its way in the way a person would, and waits for
the rows to arrive rather than for the network to go quiet: the log is fetched
after the panel renders, so `networkidle` fires before there is anything to
photograph.
"""
import os
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    os.environ.get(
        "VESOPA_SHOT_DIR",
        r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-09-wallet-log",
    )
)
BASE = os.environ.get("VESOPA_BO_BASE", "https://backoffice.vesopaepos.com")


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
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)

        # Open the Commerce group first. Every nav section now starts closed,
        # so the Wallet button exists in the DOM and is not visible — which
        # presents as playwright retrying a click for thirty seconds.
        page.click('[data-group="commerce"]')
        page.wait_for_timeout(600)

        # Into the wallet view, then the Apple tab that carries the log.
        page.click('[data-view="wallet"]')
        page.wait_for_timeout(1500)
        page.click('[data-waltab="apple"]')

        # The rows, not the network. See the note at the top.
        page.wait_for_selector("#wallet-events table, #wallet-events p", timeout=20000)
        page.wait_for_timeout(1200)

        page.screenshot(path=str(OUT / "wallet-activity-1440.png"), full_page=True)
        print("shot wallet-activity-1440")

        # And the summary line on its own, which is the part meant to be read
        # at a glance.
        box = page.query_selector("#wallet-events-summary")
        if box:
            box.screenshot(path=str(OUT / "wallet-summary.png"))
            print("shot wallet-summary")

        browser.close()
    print("saved to", OUT)


if __name__ == "__main__":
    main()

"""Prove the rail's Find a page box, and photograph it.

Folding every group is what the venue asked for; being unable to find
Timesheets without knowing it lives under Reports is what that costs. This is
the check that it does not.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680"
)
BASE = "https://backoffice.vesopaepos.com"


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


VISIBLE = (
    "() => [...document.querySelectorAll('.rail .nav, .rail .nav-group')]"
    ".filter(e => e.offsetParent !== null)"
    ".map(e => e.textContent.replace('▼','').replace('►','').trim())"
)


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "railfind"
    cfg = env()
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1440, "height": 960}, color_scheme="dark"
        )
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(1500)

        print("folded:", page.evaluate(VISIBLE))

        page.fill("#rail-find", "time")
        page.wait_for_timeout(400)
        found = page.evaluate(VISIBLE)
        print("'time' finds:", found)
        page.screenshot(path=str(OUT / f"{tag}-find-time.png"))

        page.fill("#rail-find", "report")
        page.wait_for_timeout(400)
        print("'report' finds:", page.evaluate(VISIBLE))
        page.screenshot(path=str(OUT / f"{tag}-find-report.png"))

        page.fill("#rail-find", "")
        page.dispatch_event("#rail-find", "input")
        page.wait_for_timeout(400)
        print("cleared:", page.evaluate(VISIBLE))

        # The font size the tablet guard cares about, read off the live page.
        print(
            "search box font-size:",
            page.eval_on_selector(
                "#rail-find", "e => getComputedStyle(e).fontSize"
            ),
        )
        browser.close()


if __name__ == "__main__":
    main()

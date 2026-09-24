"""Sign into the live back office and photograph the screens 1.6.8.0 changes.

Credentials come out of .env.claude-tools so they never appear in a command
line or a transcript. Shots land in Documents\\Vesopa-Claude-Images, which is
where every image this project looks at is kept.
"""
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    os.environ.get(
        "VESOPA_SHOT_DIR",
        r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680",
    )
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


VIEWS = [
    ("dashboard", "/dashboard"),
    ("products", "/products"),
    ("mix-match", "/mix-match"),
    ("customers", "/customers"),
    ("loyalty", "/loyalty"),
    ("run-report", "/run-report"),
]


def main():
    cfg = env()
    OUT.mkdir(parents=True, exist_ok=True)
    tag = sys.argv[1] if len(sys.argv) > 1 else "before"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('form#login-form button[type="submit"], button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)
        page.wait_for_timeout(2500)

        for name, path in VIEWS:
            page.goto(f"{BASE}{path}", wait_until="networkidle")
            page.wait_for_timeout(2000)
            page.screenshot(path=str(OUT / f"{tag}-{name}.png"), full_page=False)
            print("shot", name)

        # The rail on its own, tall, so the fold state and the group headings
        # are both readable.
        rail = page.query_selector("#rail")
        if rail:
            rail.screenshot(path=str(OUT / f"{tag}-rail.png"))
            print("shot rail")

        browser.close()
    print("written to", OUT)


if __name__ == "__main__":
    main()

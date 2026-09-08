"""Photograph one back-office view at chosen widths.

    python tool/bo_shot.py <tag> <path> <width>[,<width>...]
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
    tag = sys.argv[1]
    path = sys.argv[2]
    widths = [int(w) for w in (sys.argv[3] if len(sys.argv) > 3 else "1440").split(",")]
    full = "--full" in sys.argv

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": widths[0], "height": 960})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)

        for width in widths:
            page.set_viewport_size({"width": width, "height": 960})
            page.goto(f"{BASE}{path}", wait_until="networkidle")
            page.wait_for_timeout(1800)
            name = path.strip("/").replace("/", "-") or "home"
            page.screenshot(
                path=str(OUT / f"{tag}-{name}-{width}.png"), full_page=full
            )
            print("shot", name, width)
        browser.close()


if __name__ == "__main__":
    main()

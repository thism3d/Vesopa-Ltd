"""Photograph the back office in Night mode, where the venue works.

    python tool/bo_dark.py <tag>          # e.g. before, after

The tag is required, and there is no default. It used to default to "before",
and running it a second time after a fix silently overwrote the evidence of the
fault — which is the one thing these shots exist for.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680"
)
BASE = "https://backoffice.vesopaepos.com"

# Re-creates the fault fixed in 1.6.8.0, for a "before" shot on a server that no
# longer has it: `.cell-edit` cleared the chevron with a shorthand, and the dark
# rule put the image back on its own, so it painted at 0% 0% over the text.
OLD_CSS = """
select.cell-edit {
  padding-right: 6px !important;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a2ae' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") !important;
  background-position: 0% 0% !important;
  background-size: auto !important;
  background-repeat: repeat !important;
}
"""

VIEWS = ("/products", "/dashboard", "/mix-match", "/customers")


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
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    tag = sys.argv[1]
    # Reproduce the pre-1.6.8.0 chevron bug on a fixed server.
    reconstruct = "--reconstruct-chevron-bug" in sys.argv

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
        for path in VIEWS:
            page.goto(f"{BASE}{path}", wait_until="networkidle")
            page.wait_for_timeout(1500)
            if reconstruct:
                page.add_style_tag(content=OLD_CSS)
                page.wait_for_timeout(400)
            name = f"{tag}-dark-{path.strip('/')}.png"
            target = OUT / name
            if target.exists():
                print("refusing to overwrite", target.name)
                continue
            page.screenshot(path=str(target))
            print("shot", name)
        browser.close()


if __name__ == "__main__":
    main()

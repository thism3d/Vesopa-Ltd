"""Measure elements on a live auth.vesopa.com page.

    python tool/auth_measure.py login ".btn"

Prints the box of every match. Written because "they look the same height" is
not a measurement, and a two-pixel difference in a vertical stack of buttons is
visible without being identifiable.
"""

import sys

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"


def main():
    path = "/" + (sys.argv[1] if len(sys.argv) > 1 else "login").lstrip("/")
    selector = sys.argv[2] if len(sys.argv) > 2 else ".btn"

    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{BASE}{path}", wait_until="load", timeout=30000)
        page.wait_for_timeout(400)

        boxes = page.eval_on_selector_all(
            selector,
            """els => els.map(el => {
                const r = el.getBoundingClientRect();
                return {
                  text: (el.textContent || '').trim().slice(0, 34),
                  x: Math.round(r.x * 100) / 100,
                  width: Math.round(r.width * 100) / 100,
                  height: Math.round(r.height * 100) / 100,
                };
            })""",
        )

        print(f"{selector} on {path} — {len(boxes)} element(s)\n")
        print(f"{'element':<36}{'x':>9}{'width':>10}{'height':>9}")
        for box in boxes:
            print(f"{box['text']:<36}{box['x']:>9}{box['width']:>10}{box['height']:>9}")

        widths = {b["width"] for b in boxes}
        heights = {b["height"] for b in boxes}
        lefts = {b["x"] for b in boxes}
        print()
        print(f"widths  identical: {len(widths) == 1}  {sorted(widths)}")
        print(f"heights identical: {len(heights) == 1}  {sorted(heights)}")
        print(f"left edges aligned: {len(lefts) == 1}  {sorted(lefts)}")

        browser.close()


if __name__ == "__main__":
    main()

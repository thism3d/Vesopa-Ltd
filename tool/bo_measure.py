"""Measure the Products table's department cells at several widths.

The venue reports "arrows overlapping the departments and sub departments".
This prints numbers rather than opinions: the select's box, the width its own
text wants, and whether the two collide once the browser's arrow is allowed for.
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

PROBE = """
() => {
  const out = [];
  const cells = document.querySelectorAll('#products select.cell-edit');
  for (const s of [...cells].slice(0, 6)) {
    const cs = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    // What the chosen option's text alone wants, measured in the same font.
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;'
      + 'font:' + cs.font;
    span.textContent = s.options[s.selectedIndex]?.text ?? '';
    document.body.appendChild(span);
    const textWidth = span.getBoundingClientRect().width;
    span.remove();
    out.push({
      field: s.dataset.cell,
      text: span.textContent,
      boxWidth: +r.width.toFixed(1),
      textWidth: +textWidth.toFixed(1),
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      appearance: cs.appearance,
      textOverflow: cs.textOverflow,
      // Chrome draws its arrow in roughly the last 16px of the box.
      roomForArrow: +(r.width
        - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - textWidth).toFixed(1),
    });
  }
  return out;
}
"""


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
    tag = sys.argv[1] if len(sys.argv) > 1 else "before"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)

        for width in (1440, 1180, 1024, 900):
            page.set_viewport_size({"width": width, "height": 960})
            page.goto(f"{BASE}/products", wait_until="networkidle")
            page.wait_for_timeout(1500)
            print(f"--- {width}px ---")
            for row in page.evaluate(PROBE):
                print(" ", row)
            page.screenshot(path=str(OUT / f"{tag}-products-{width}.png"))

        browser.close()


if __name__ == "__main__":
    main()

"""Open the product edit form on the live back office and photograph it."""
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

MEASURE = """
() => {
  const out = [];
  for (const s of document.querySelectorAll('dialog select, .modal select')) {
    const cs = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + cs.font;
    span.textContent = s.options[s.selectedIndex]?.text ?? '';
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    span.remove();
    out.push({
      name: s.name || s.id || s.dataset.cell,
      text: span.textContent,
      box: +r.width.toFixed(1),
      textW: +w.toFixed(1),
      padRight: cs.paddingRight,
      bgImage: cs.backgroundImage === 'none' ? 'none' : 'chevron',
      bgPos: cs.backgroundPosition,
      overlap: +(w + parseFloat(cs.paddingLeft) - (r.width - 30)).toFixed(1),
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
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)
        page.goto(f"{BASE}/products", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.click("[data-edit-product]")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / f"{tag}-product-form.png"))
        for row in page.evaluate(MEASURE):
            print(row)
        browser.close()


if __name__ == "__main__":
    main()
